/**
 * HTTP bridge for the settings card.
 *
 * Why this exists
 * ---------------
 * DSH renders a plugin's configuration card from the plugin's own browser-side
 * half (`exports["./client"]` + `dsh.client` in package.json). The card is drawn
 * by the plugin, not by DSH, so the plugin has to ship its own transport for
 * reading and writing values. `dsh-free-search` - the only shipped plugin that
 * puts controls on the plugin page - does exactly this: it registers
 * `/api/dsh-free-search-settings/{describe,mutate}` on the DSH webServer and the
 * card talks to it with fetch(). Verified in its lib/index.js and lib/client.js.
 *
 * This module is the simpler half of that pair: two exact routes over the same
 * `settings.json` the CLI writes, so the card and the CLI can never disagree.
 *
 * Route mount point (verified): `ctx.get("webServer").register(route)` where
 * route is `{ kind: "exact", path, handler(req, res) }`. `webServer` is not in
 * the module-level `inject` list on purpose - see the note there about fibers
 * having to stay mounted for the card to appear at all - so it is grabbed with
 * `ctx.inject(["webServer"], ...)` and every access is guarded.
 */

import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SETTING_SPECS, readStored, writeStored, coerce } from './settings-store.js';

export const BRIDGE_PREFIX = '/api/dsh-simple-notify-settings';

/** 与 index.js 里写的那份同一个文件，浏览器日志追加到末尾。 */
const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'turn-notify.log');

const MAX_BODY_BYTES = 64 * 1024;

function writeJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.statusCode = status;
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
  }
  res.end(text);
}

/** Collect the request body, refusing anything oversized. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        finish(undefined);
        return;
      }
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(undefined);
      }
    });
    req.on('error', () => finish(undefined));
  });
}

/**
 * Only the local page may drive the card.
 *
 * The DSH web UI is served from 127.0.0.1, so a Host header naming a loopback
 * address is the normal case. A DNS-rebinding attack would present an attacker
 * hostname here, so anything that is not loopback is refused. That is stricter
 * than the trusted-host list free-search keeps but this endpoint only ever
 * serves the local desktop window.
 */
function isLocalHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function guard(req, res, method) {
  if (!isLocalHost(req.headers?.host)) {
    writeJson(res, 403, { ok: false, error: 'settings bridge only answers loopback requests' });
    return false;
  }
  if (req.method !== method) {
    writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method ?? ''}` });
    return false;
  }
  return true;
}

/**
 * Shape one settings view for the browser.
 *
 * `specs` carries label/help/kind/values so the card never duplicates the
 * wording, and `values` carries what the card should draw. `defaults` is
 * resolved by the caller because the schema lives in index.js.
 */
export function describeSettings(defaults) {
  const stored = readStored();
  const specs = {};
  for (const [key, spec] of Object.entries(SETTING_SPECS)) {
    specs[key] = {
      kind: spec.kind,
      label: spec.label,
      help: spec.help,
      ...(spec.values === undefined ? {} : { values: spec.values }),
    };
  }
  const values = {};
  const origins = {};
  for (const key of Object.keys(SETTING_SPECS)) {
    if (Object.hasOwn(stored.values, key)) {
      values[key] = stored.values[key];
      origins[key] = 'settings.json';
    } else if (Object.hasOwn(defaults, key)) {
      values[key] = defaults[key];
      origins[key] = 'default';
    } else {
      origins[key] = 'unset';
    }
  }
  return { ok: true, specs, values, defaults, stored: stored.values, origins, problems: stored.problems };
}

/**
 * Apply a `{ key: rawValue }` patch on top of what is already stored.
 *
 * Every key is validated through `coerce` first; one bad key rejects the whole
 * patch so the card never ends up half-applied. A `null` value removes the key,
 * which is how the card's "reset this one" button works.
 */
export function applySettingsPatch(patch, defaultsForEcho = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'body must be an object of setting names to values' };
  }
  const stored = readStored();
  const next = { ...stored.values };
  const changed = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === null) {
      delete next[key];
      changed[key] = null;
      continue;
    }
    const result = coerce(key, raw);
    if (!result.ok) return { ok: false, error: result.reason };
    next[key] = result.value;
    changed[key] = result.value;
  }
  const file = writeStored(next);
  // 回带一份完整视图，卡片就不用再拉一次 describe
  return { ok: true, changed, file, ...describeSettings(defaultsForEcho) };
}

/**
 * Build the route list. Caller mounts each one on `webServer`.
 *
 * `onApplied` receives the freshly written stored values so the host can refresh
 * whatever it reads at notification time. Without it a switch saved from the card
 * would only take effect after a restart.
 *
 * @param getDefaults  () => plain object of schema default values
 * @param options      { onApplied?: (stored: object) => void }
 */
export function makeSettingsRoutes(getDefaults, options = {}) {
  const onApplied = typeof options?.onApplied === 'function' ? options.onApplied : undefined;
  return [
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/describe`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        try {
          writeJson(res, 200, describeSettings(getDefaults()));
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/mutate`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, error: 'malformed or oversized JSON body' });
          return;
        }
        try {
          const result = applySettingsPatch(body, getDefaults());
          if (result.ok && onApplied !== undefined) {
            try {
              onApplied(readStored().values);
            } catch {
              /* 刷新失败不影响已经写成功的文件 */
            }
          }
          writeJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error) });
        }
      },
    },
    {
      // 浏览器侧的诊断日志。卡片渲染不出来时，前端没有别的办法把现场信息
      // 交给宿主——DevTools 不一定开着，所以这里开一条只写的日志通道。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/log`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const body = await readJsonBody(req);
        const msg = body && typeof body.msg === 'string' ? body.msg.slice(0, 2000) : '(empty)';
        try {
          appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [client] ${msg}\n`, 'utf8');
        } catch {
          /* 日志写不进去不影响主流程 */
        }
        writeJson(res, 200, { ok: true });
      },
    },
  ];
}
