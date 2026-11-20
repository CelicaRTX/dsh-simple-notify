/**
 * dsh-simple-notify - settings storage.
 *
 * Values live in one small JSON file next to this module:
 *
 *   ~/.dsh/simple-notify/settings.json     (or $DSH_HOME/simple-notify/...)
 *
 * Why a file of our own instead of the cordis settings service:
 *
 * - The settings service only exposes a card when the host has a *client half*
 *   for the plugin (`package.json` -> `exports["./client"]` + a `lib/client.js`
 *   that registers into a `plugins.*.config` slot). Without that the card never
 *   renders, no matter how correct the Config schema is.
 * - A standalone JSON file survives DSH upgrades, profile rebuilds and plugin
 *   reinstalls, and it can be edited by hand as a last resort.
 *
 * Precedence, highest first:
 *   1. settings.json (written by the `notify_config` tool or by hand)
 *   2. cordis.patch.yml `config:` block, via the object handed to `apply()`
 *   3. the schema defaults declared in index.js
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Every key the plugin understands, with the range it accepts.
 *
 * `invert: true` means the boolean is stored reversed: the UI shows a question
 * whose natural answer is "on" ("播放声音"), while the shell flag underneath is
 * "silent". Kept in one place so the UI, the CLI and the reader all agree.
 *
 * `implemented: false` marks an option the card still shows but which has no
 * effect yet; the card prints its help text greyed out.
 */
export const SETTING_SPECS = {
  sound: {
    kind: 'boolean',
    invert: true,
    label: '播放声音',
    help: '弹出提醒时播放系统的提示音。',
    implemented: true,
  },
  fullscreenNotify: {
    kind: 'boolean',
    invert: true,
    label: '运行全屏程序时提示',
    help: '你正在全屏看视频或玩游戏时，也弹出提醒。',
    implemented: true,
  },
  suppressWhenForeground: {
    kind: 'boolean',
    label: '在前台时不提示',
    help: 'DSH 窗口本来就是活动窗口时不打扰你。关掉后即使你正看着它也会弹。',
    implemented: true,
  },
  showQuestions: {
    kind: 'boolean',
    label: '需要用户做出选择时提示',
    help: '我停下来等你点选项时，单独弹一个提醒。',
    implemented: true,
  },
};

/**
 * Old key names, kept readable forever.
 *
 * `silent` was a negative question ("关闭提示音") and is now `sound`, a positive
 * one. The stored value keeps its original meaning, so a settings file written
 * before the rename is translated on read rather than ignored.
 */
export const LEGACY_KEYS = {
  silent: 'sound',
  fullscreenMode: 'fullscreenNotify',
};

/** Translate one stored key/value pair into the current vocabulary. */
export function translateLegacy(key, value) {
  if (key === 'silent') return { key: 'sound', value: value !== true };
  if (key === 'fullscreenMode') return { key: 'fullscreenNotify', value: value !== 'skip' };
  return { key, value };
}

/**
 * Where settings.json lives.
 *
 * $DSH_HOME wins when the host sets it (the desktop app does), so a moved data
 * directory takes the settings with it.
 */
export function settingsDir() {
  const home = String(process.env.DSH_HOME ?? '').trim();
  const base = home === '' ? join(homedir(), '.dsh') : home;
  return join(base, 'simple-notify');
}

export function settingsPath() {
  return join(settingsDir(), 'settings.json');
}

/**
 * Read the stored settings.
 *
 * A corrupt or unreadable file is reported as an empty object rather than an
 * exception: a broken settings file must never stop notifications from working.
 *
 * @returns {{ values: Record<string, unknown>, problems: string[] }}
 */
export function readStored() {
  const path = settingsPath();
  if (!existsSync(path)) return { values: {}, problems: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { values: {}, problems: [`${path} 顶层不是对象，已忽略`] };
    }
    // 旧键名（silent / fullscreenMode）在读取时翻译成新词。
    // 这样改名之前的 settings.json 仍然有效，不会被默默当成空文件。
    const values = {};
    const problems = [];
    for (const [oldKey, raw] of Object.entries(parsed)) {
      if (!Object.hasOwn(SETTING_SPECS, oldKey)) {
        const renamed = translateLegacy(oldKey, raw);
        if (renamed.key !== oldKey) {
          values[renamed.key] = renamed.value;
          problems.push(`旧键 "${oldKey}" 已按新键 "${renamed.key}" 解释`);
          continue;
        }
      }
      values[oldKey] = raw;
    }
    return { values, problems };
  } catch (error) {
    return { values: {}, problems: [`${path} 读不出来：${String(error)}`] };
  }
}

/**
 * Write the whole settings object.
 *
 * Written to a sibling temp file and renamed over the target, so a crash
 * mid-write cannot leave a half-parsed JSON behind.
 */
export function writeStored(values) {
  const dir = settingsDir();
  mkdirSync(dir, { recursive: true });
  const path = settingsPath();
  const temp = join(dir, `.settings.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
  return path;
}

/**
 * Check one raw value against its spec.
 *
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string }}
 */
export function coerce(key, raw) {
  const spec = SETTING_SPECS[key];
  if (spec === undefined) {
    return { ok: false, reason: `不认识的设置项 "${key}"。可用：${Object.keys(SETTING_SPECS).join(', ')}` };
  }
  if (spec.kind === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const text = String(raw).trim().toLowerCase();
    if (['true', '1', 'on', 'yes', '开', '是'].includes(text)) return { ok: true, value: true };
    if (['false', '0', 'off', 'no', '关', '否'].includes(text)) return { ok: true, value: false };
    return { ok: false, reason: `"${key}" 要 true 或 false，收到 "${raw}"` };
  }
  const text = String(raw).trim();
  if (!spec.values.includes(text)) {
    return { ok: false, reason: `"${key}" 只能是 ${spec.values.join(' / ')}，收到 "${raw}"` };
  }
  return { ok: true, value: text };
}

/**
 * Merge store over YAML config over defaults, and say where each value came from.
 *
 * The merged object is in the *UI vocabulary* (sound / fullscreenNotify, both
 * positive questions). `toShellFlags()` below turns it into the flags the
 * PowerShell side actually reads.
 *
 * @param config  the object `apply()` received (cordis.patch.yml `config:`)
 * @param store   the parsed settings.json
 */
export function resolveAll(config, store) {
  const merged = {};
  const origins = {};
  for (const key of Object.keys(SETTING_SPECS)) {
    if (Object.hasOwn(store, key)) {
      merged[key] = store[key];
      origins[key] = 'settings.json';
    } else if (config !== null && typeof config === 'object' && Object.hasOwn(config, key)) {
      merged[key] = config[key];
      origins[key] = 'cordis.patch.yml';
    } else {
      origins[key] = 'default';
    }
  }
  return { merged, origins };
}

/**
 * Turn the UI vocabulary into the flags notify.ps1 reads.
 *
 * Always returns concrete booleans / strings. An earlier version passed
 * `undefined` through so "the shell decides", but the caller could not tell
 * "no opinion" from "explicitly on", and `sound:false` silently became a
 * default chime. Defaults now live here and nowhere else:
 *
 *   sound absent            -> audible (silent = false)
 *   fullscreenNotify absent -> still draw over a fullscreen app ('show')
 */
export function toShellFlags(merged) {
  const silent = merged.sound === false;
  const fullscreenMode = merged.fullscreenNotify === false ? 'skip' : 'show';
  return { silent, fullscreenMode };
}

/** Human-readable dump used by `node lib/settings-cli.js show`. */
export function describeAll({ merged, origins }) {
  const lines = [];
  for (const [key, spec] of Object.entries(SETTING_SPECS)) {
    const value = merged[key];
    const shown = value === undefined ? '(默认)' : JSON.stringify(value);
    const flag = spec.invert === true ? '  ← 反义存储' : '';
    lines.push(`${key} = ${shown}    [${origins[key]}]  ${spec.label}${flag}`);
  }
  lines.push('');
  lines.push(`配置文件：${settingsPath()}`);
  return lines.join('\n');
}

/** Sibling of settingsPath(), exported so error messages can name the folder. */
export function settingsFileDir() {
  return dirname(settingsPath());
}
