/**
 * dsh-simple-notify - desktop toast when a turn finishes while the user is
 * looking at something else, plus a daily startup self-check.
 *
 * All facts below were verified against dsh 0.2.0-rc.2:
 *
 * - `agent/turn-stopping` is dispatched by @deepseek-ai/dsh-agent-loop through
 *   `agentEvents()`, which fuses `{ agent }` into the payload, so a listener
 *   receives `{ agent, turn, signal }`.
 *
 * - The session title comes from the `sessionTitle` service:
 *   `ctx.get('sessionTitle').get(session)` -> `{ title, ... }` or undefined.
 *
 * - Subagent sessions carry `session.header.origin === 'subagent'`; the
 *   SessionHeader declaration pins that literal, and `list.js` copies it into
 *   the session-list row.
 *
 * - The foreground check and the toast both run inside one PowerShell script.
 *   The script is pure ASCII and receives its text as Base64-encoded UTF-8,
 *   because PowerShell 5.1 decodes .ps1 files with the ANSI code page and
 *   corrupts any literal non-ASCII characters.
 *
 * On load, a self-check runs once per calendar day (see selfcheck.js). Any
 * problem it finds is reported through a toast that deliberately ignores the
 * foreground rule: an error the user cannot see is worse than an interruption.
 *
 * ---------------------------------------------------------------------------
 * Asking the user also counts as waiting
 * ---------------------------------------------------------------------------
 * `ask_user_question` blocks inside `ctx.userQuestions.ask()` until the human
 * answers, so the turn never stops and `agent/turn-stopping` never fires: a
 * question card that appears while the user is looking elsewhere is invisible,
 * which is exactly the case a notification exists for.
 *
 * Hook: `user-questions/request` (dsh-user-questions/lib/index.js:681). It is a
 * cordis *waterfall*, whose mechanics were read from cordis/src/events.ts
 * 234-243:
 *
 *   const cbs = this.dispatch('waterfall', args)   // 235
 *   const inner = args.pop()                       // 236 - the real downstream
 *   const next = () => {
 *     const cb = cbs.shift() ?? inner
 *     return cb(...args)                           // 239
 *   }
 *   args.push(next)                                // 241
 *   return next()                                  // 242
 *
 * Two consequences shape the listener below. First, `dispatch` consumes the
 * carrier and the event name, and the built-in answerer that the caller passed
 * becomes the chain's `inner`; the signature a listener must declare is
 * therefore `(request, next)` - see `args` in the code above. Declaring
 * `(request, noAnswerer, next)` instead leaves `next` undefined and throws on
 * the first call. Second, a listener that does not call `next()` vetoes the rest
 * of the chain *including the built-in answerer*, which here would silently
 * swallow the question card. So the listener must always return `next()`,
 * forwards nothing of its own, and keeps every side effect inside a try/catch:
 * a throw inside a waterfall listener would reject the whole call.
 *
 * The projection `userQuestions` is NOT usable here: `applyUserQuestionEvent`
 * returns early unless the tool runs in `timed` mode
 * (dsh-user-questions/lib/index.js:200), and `desktop` mounts
 * `@deepseek-ai/dsh-tool-ask-user` with no config, so the schema default
 * `mode: 'legacy'` applies and that projection stays empty forever.
 */

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { selfCheckOncePerDay, selfCheckReport } from './selfcheck.js';

export const name = 'dsh-simple-notify';
export const inject = ['sessions'];

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(HERE);
const SCRIPT = join(HERE, 'notify.ps1');
const LOG = join(HERE, 'turn-notify.log');
const STAMP = join(HERE, '.last-selfcheck');

/**
 * The profile that loads this plugin.
 *
 * Resolved in this order, so a moved DSH_HOME does not silently point the
 * self-check at a stale directory:
 *   1. `config.profileDir` (explicit)
 *   2. `DSH_PROFILE_DIR`
 *   3. `<DSH_HOME>/profiles/<DSH_PROFILE>`
 *   4. Plugin_DIR/../.. — the profile's node_modules usually links here, so two
 *      levels up from the plugin is the profile root when it is linked in
 *      place. The junction check in selfcheck.js then verifies it resolves.
 */
function resolveProfileDir(config) {
  const explicit = cleanTitle(config.profileDir);
  if (explicit !== '') return explicit;

  const envProfile = cleanTitle(process.env.DSH_PROFILE_DIR);
  if (envProfile !== '') return envProfile;

  const home = cleanTitle(process.env.DSH_HOME);
  const profile = cleanTitle(process.env.DSH_PROFILE) || 'desktop';
  if (home !== '') return join(home, 'profiles', profile);

  return dirname(dirname(PLUGIN_DIR));
}

function trace(message) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // Logging must never break the plugin.
  }
}

function base64Utf8(text) {
  return Buffer.from(String(text ?? ''), 'utf8').toString('base64');
}

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length === 0 ? '' : trimmed;
}

/**
 * Where `powershell.exe` lives.
 *
 * The bare name is correct on Windows: the system directory is always on PATH
 * for a desktop-launched Electron process. `pwsh` is preferred when the caller
 * configured it, but PowerShell 5.1 is the guaranteed floor and the only one
 * that exists on a stock Windows install.
 */
function defaultPowershell() {
  return process.env.DSH_NOTIFY_POWERSHELL ?? 'powershell.exe';
}

/**
 * The process id whose window a click on the notification should bring forward.
 *
 * This plugin runs inside the DSH host process, which is NOT the process that
 * owns the Electron window: both processes carry the app's name, and the host
 * has no window at all (`process.pid` is therefore useless here). The window
 * process is found by name, and the answer is cached for the rest of the
 * process's life.
 *
 * Re-checking on every notification would be wasted work; re-checking never is
 * equally wrong, because a restarted window comes back with a new pid. The
 * cache therefore stores the name it was resolved for and is refreshed when a
 * notification is sent after the pid has gone.
 *
 * Wrapped in try/catch on purpose: PowerShell being unavailable must degrade
 * to "the notification is not clickable", never to "no notification".
 */
function resolveWindowPid(appNames) {
  let cached = { pid: 0, names: '' };
  const wanted = appNames.join('|');

  const query = () => {
    const names = appNames.map((n) => String(n).replace(/'/g, "''")).join("','");
    const script =
      `Get-Process -Name '${names}' -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.MainWindowHandle -ne 0 } | ` +
      `Select-Object -First 1 -ExpandProperty Id`;
    try {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const pid = Number.parseInt(out.trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : 0;
    } catch (error) {
      trace(`window pid lookup failed: ${String(error)}`);
      return 0;
    }
  };

  const fresh = () => (cached.names === wanted && cached.pid > 0 && alive(cached.pid) ? cached.pid : 0);

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  return () => {
    const hit = fresh();
    if (hit !== 0) return hit;
    const pid = query();
    cached = { pid, names: wanted };
    return pid;
  };
}

class Notifier {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.powershell = config.powershellPath ?? defaultPowershell();
    this.script = config.scriptPath ?? SCRIPT;
    this.title = config.title ?? '任务完成';
    this.aumid = config.aumid ?? 'com.deepseek.dsh';
    this.appNames = Array.isArray(config.appProcessNames) && config.appProcessNames.length > 0
      ? config.appProcessNames
      : ['DeepSeek Harness'];

    // 'auto' asks the shell whether a banner would be drawn and falls back to a
    // self-drawn topmost window when it would not (fullscreen app, quiet time).
    // See the header comment of notify.ps1 for the measurements behind this.
    this.mode = ['auto', 'toast', 'overlay'].includes(config.mode) ? config.mode : 'auto';
    this.holdMs = Number.isFinite(config.holdMs) && config.holdMs >= 800 ? config.holdMs : 4200;

    // Clicking the notification focuses the DSH window. `config.clickToFocus
    // === false` turns the behaviour off and leaves a plain, inert toast.
    this.windowPid = config.clickToFocus === false ? () => 0 : resolveWindowPid(this.appNames);
  }

  /**
   * Send one notification.
   *
   * @param body - body text (may be empty)
   * @param options.suppressWhenForeground - apply the focus rule
   * @param options.title - override the heading
   */
  send(body, { suppressWhenForeground = true, title } = {}) {
    const windowPid = this.windowPid();
    const env = {
      ...process.env,
      DSH_NOTIFY_TITLE_B64: base64Utf8(title ?? this.title),
      DSH_NOTIFY_BODY_B64: base64Utf8(body),
      DSH_NOTIFY_SKIP_FOREGROUND: suppressWhenForeground ? '1' : '0',
      DSH_NOTIFY_AUMID: this.aumid,
      DSH_NOTIFY_APP_NAMES_B64: base64Utf8(this.appNames.join('|')),
      DSH_NOTIFY_MODE: this.mode,
      DSH_NOTIFY_HOLD_MS: String(this.holdMs),
    };

    // '0' and an absent variable both mean "not clickable"; passing the value
    // explicitly keeps the log honest about which of the two happened.
    if (windowPid > 0) env.DSH_NOTIFY_WINDOW_PID = String(windowPid);

    const child = spawn(
      this.powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script],
      { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );

    // Keep the script's verdict. Without it the log cannot tell the three cases
    // apart that look identical from the outside: the notification was shown,
    // the foreground rule skipped it, or Windows swallowed the banner (a
    // fullscreen app puts the shell in QUNS_BUSY and Show() still returns
    // without error).
    let out = '';
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.stderr?.on('data', (chunk) => { out += String(chunk); });

    child.on('error', (error) => trace(`spawn error: ${String(error)}`));
    child.on('exit', (code) => {
      const verdict = out.trim().replace(/\s+/g, ' ').slice(0, 200);
      trace(`powershell exited with ${code}; verdict=${JSON.stringify(verdict)}`);
    });
    return child;
  }
}

/** Run the once-a-day self-check and report anything it finds. */
function runStartupCheck(notifier, config) {
  const checkOptions = {
    profileDir: resolveProfileDir(config),
    pluginDir: PLUGIN_DIR,
    aumid: notifier.aumid,
    appName: notifier.appNames[0] ?? 'DeepSeek Harness',
  };

  let result;
  try {
    result = selfCheckOncePerDay({
      ...checkOptions,
      stampPath: STAMP,
    });
  } catch (error) {
    trace(`self-check threw: ${String(error)}`);
    return;
  }

  if (!result.ran) {
    trace('self-check already ran today; skipped');
    return;
  }

  // Log what was verified, not only what broke: on a fresh machine the AUMID
  // note is the one line that proves toasts can appear at all.
  try {
    const report = selfCheckReport(checkOptions);
    for (const note of report.info) trace(`self-check: ${note}`);
  } catch (error) {
    trace(`self-check report threw: ${String(error)}`);
  }

  if (result.problems.length === 0) {
    trace('self-check passed');
    return;
  }

  for (const problem of result.problems) trace(`self-check FAILED: ${problem}`);

  const body = result.problems.slice(0, 3).join(' ; ');
  const more = result.problems.length > 3 ? ` (+${result.problems.length - 3})` : '';
  notifier.send(`自检发现问题:${body}${more}`, {
    suppressWhenForeground: false,
    title: '气泡插件自检失败',
  });
}

export function apply(ctx, config = {}) {
  trace(`apply() called; config=${JSON.stringify(config)}`);

  if (config.enabled === false) {
    trace('disabled by config; not registering listener');
    return;
  }

  const notifier = new Notifier(ctx, config);
  const suppressWhenForeground = config.suppressWhenForeground !== false;
  const showSubagents = config.showSubagents === true;
  const showQuestions = config.showQuestions !== false;

  runStartupCheck(notifier, config);

  trace(`registering listener; script=${notifier.script}`);

  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      const session = agent?.session;
      if (session === undefined) {
        trace('turn-stopping without a session; ignored');
        return;
      }

      const header = session.header;
      if (!showSubagents && header?.origin === 'subagent') {
        trace(`subagent session ${header?.id}; ignored`);
        return;
      }

      let title = '';
      try {
        const titles = ctx.get('sessionTitle');
        title = cleanTitle(titles?.get(session)?.title);
        trace(`title lookup -> ${JSON.stringify(title)}`);
      } catch (error) {
        trace(`title lookup failed: ${String(error)}`);
      }

      const body = title === '' ? '' : `任务:${title}`;
      notifier.send(body, { suppressWhenForeground, title: config.title ?? '任务完成' });
    } catch (error) {
      trace(`listener error: ${String(error)}`);
    }
  });

  trace('listener registered');

  registerQuestionListener({ ctx, notifier, suppressWhenForeground, showSubagents, showQuestions });
}

/**
 * Describe the first question of a request in one line.
 *
 * The toast body has room for a couple of short lines, so the heading names the
 * conversation and the body carries the question the model is waiting on. A
 * batch shows its first question and a count of the rest.
 */
function describeQuestions(questions) {
  const list = Array.isArray(questions) ? questions : [];
  if (list.length === 0) return '';
  const first = list[0] ?? {};
  const text = typeof first.question === 'string' ? first.question.trim() : '';
  const more = list.length > 1 ? ` (+${list.length - 1})` : '';
  return `${text}${more}`.slice(0, 180);
}

/**
 * Notify when the assistant asks a question and starts waiting for the answer.
 *
 * This listener sits in a cordis waterfall chain, so it must forward to `next()`
 * on every path and must never let its own failure escape: see the header
 * comment for why either violation breaks the user's question card.
 *
 * The toast is fired and forgotten. Awaiting the PowerShell child would delay
 * `next()` and therefore the question card itself.
 */
function registerQuestionListener({ ctx, notifier, suppressWhenForeground, showSubagents, showQuestions }) {
  if (!showQuestions) {
    trace('question listener disabled by config');
    return;
  }

  ctx.on('user-questions/request', (request, next) => {
    try {
      const agent = request?.agent;
      const session = agent?.session;
      const origin = session?.header?.origin;

      if (!showSubagents && origin === 'subagent') {
        trace('question from a subagent session; toast skipped');
      } else {
        let title = '';
        try {
          const titles = ctx.get('sessionTitle');
          title = cleanTitle(titles?.get(session)?.title);
        } catch (error) {
          trace(`question title lookup failed: ${String(error)}`);
        }

        const body = describeQuestions(request?.questions);
        trace(`question request -> ${JSON.stringify(body)}; title=${JSON.stringify(title)}`);
        notifier.send(body, {
          suppressWhenForeground,
          title: questionHeading(title),
        });
      }
    } catch (error) {
      // A throw here would reject the whole ask; swallowing is mandatory.
      trace(`question listener error: ${String(error)}`);
    }
    return next();
  });

  trace('question listener registered');
}

/** Toast heading for a question, keeping the conversation name when known. */
function questionHeading(title) {
  return title === '' ? '在等你回答' : `在等你回答 · ${title}`;
}
