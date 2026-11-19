/**
 * Startup self-check for dsh-simple-notify.
 *
 * Runs once per calendar day, at plugin load time (which is DSH startup).
 * It inspects files only — no network, no spawning, and no writes beyond the
 * daily-stamp file — and reports the failures that would make the notification
 * plugin stop working *silently*.
 *
 * The four checks are exactly the ones whose failure is invisible at runtime:
 *
 *   1. the junction in the profile's node_modules resolves
 *   2. the plugin's own files are present
 *   3. package.json still declares `exports` (a missing exports field makes the
 *      loader skip the bundle without printing anything)
 *   4. the profile still lists this bundle in dsh.profile.bundles
 *
 * Portability: every path is derived from the arguments or from the plugin's
 * own location, so the same checks run on any machine once the directory is
 * copied and linked into that machine's profile.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** This module's directory is <plugin>/lib, so the plugin root is one level up. */
export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const REQUIRED_FILES = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/notify.ps1', 'lib/toast-window.ps1'];

/** Read a JSON file, returning null when it is missing or malformed. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The Start-menu shortcut whose `System.AppUserModel.ID` makes toasts legal.
 *
 * Windows only shows a toast when its AppUserModelId resolves to a shortcut in
 * the Start menu carrying that property. The DSH installer normally writes it;
 * on a machine where it is missing, every toast is dropped WITHOUT an error,
 * which is precisely the failure this check has to name.
 *
 * The path uses %APPDATA%, so it follows the current user on any machine.
 */
function aumidShortcutPath(appName) {
  const appData = process.env.APPDATA;
  if (typeof appData !== 'string' || appData === '') return undefined;
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${appName}.lnk`);
}

/**
 * Read `System.AppUserModel.ID` from a shortcut.
 *
 * Done with `Shell.Application` rather than a shortcut parser because that is
 * the same source Taskbar/Explorer uses, and it is available on every Windows
 * install with no dependency. Returns undefined when the property cannot be
 * read, so the caller can report "unknown" instead of "missing".
 */
function readShortcutAumid(lnkPath) {
  try {
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$lnk = '${lnkPath.replace(/'/g, "''")}'`,
      'if (-not (Test-Path -LiteralPath $lnk)) { Write-Output "__MISSING__"; exit 0 }',
      '$dir = $lnk.Substring(0, $lnk.LastIndexOf([char]92))',
      '$name = $lnk.Substring($lnk.LastIndexOf([char]92) + 1)',
      '$shell = New-Object -ComObject Shell.Application',
      '$folder = $shell.Namespace($dir)',
      'if ($null -eq $folder) { Write-Output "__UNKNOWN__"; exit 0 }',
      '$item = $folder.ParseName($name)',
      'if ($null -eq $item) { Write-Output "__UNKNOWN__"; exit 0 }',
      '$v = $item.ExtendedProperty("System.AppUserModel.ID")',
      'if ([string]::IsNullOrEmpty($v)) { Write-Output "__EMPTY__" } else { Write-Output $v }',
    ].join('; ');

    const out = execFileSync(
      process.env.DSH_NOTIFY_POWERSHELL ?? 'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    ).trim();

    if (out === '__MISSING__') return { state: 'missing' };
    if (out === '__UNKNOWN__') return { state: 'unknown' };
    if (out === '__EMPTY__') return { state: 'empty' };
    return { state: 'ok', aumid: out };
  } catch (error) {
    return { state: 'unknown', error: String(error) };
  }
}

/**
 * Check that toasts can actually appear on this machine.
 *
 * Advisory only: a failure here does not stop the plugin (a toast that Windows
 * drops is still preferable to no plugin), it only gets reported.
 *
 * @param options.aumid - the AppUserModelId the toaster will use
 * @param options.appName - Start-menu shortcut base name to look for
 * @returns {{problems: string[], info: string[]}}
 */
function checkToastEligibility({ aumid, appName }) {
  const problems = [];
  const info = [];

  const lnk = aumidShortcutPath(appName);
  if (lnk === undefined) {
    problems.push('APPDATA is not set - cannot verify the toast AUMID registration');
    return { problems, info };
  }

  const found = readShortcutAumid(lnk);
  if (found.state === 'missing') {
    problems.push(
      `no Start-menu shortcut at ${lnk} - Windows will DROP every toast silently. ` +
      `Reinstall DSH, or create a shortcut to the DSH executable there and set its ` +
      `System.AppUserModel.ID to "${aumid}".`,
    );
  } else if (found.state === 'empty') {
    problems.push(
      `the shortcut ${lnk} has no System.AppUserModel.ID - Windows will DROP every ` +
      `toast silently. Set it to "${aumid}".`,
    );
  } else if (found.state === 'unknown') {
    info.push(`could not read the AUMID from ${lnk}; assuming it is fine`);
  } else if (found.aumid !== aumid) {
    problems.push(
      `the shortcut registers AUMID "${found.aumid}" but the plugin sends as "${aumid}" - ` +
      `set config aumid to "${found.aumid}", or fix the shortcut`,
    );
  } else {
    info.push(`AUMID "${aumid}" is registered by ${lnk}`);
  }

  return { problems, info };
}

/**
 * Run the checks.
 *
 * @param options.profileDir - the profile whose node_modules holds the link
 * @param options.pluginDir - this plugin's own directory
 * @param options.aumid - AppUserModelId the toaster uses (default com.deepseek.dsh)
 * @param options.appName - Start-menu shortcut base name (default 'DeepSeek Harness')
 * @param options.skipWindowsChecks - true to skip the Windows-only AUMID probe
 * @returns {string[]} human-readable problems; empty when everything is intact
 */
export function selfCheck({ profileDir, pluginDir, aumid = 'com.deepseek.dsh', appName = 'DeepSeek Harness', skipWindowsChecks = false }) {
  const problems = [];

  // 1. The junction (or plain directory) that the profile resolves.
  const link = join(profileDir, 'node_modules', 'dsh-simple-notify');
  if (!existsSync(link)) {
    problems.push(`profile link missing: ${link}`);
  } else if (!existsSync(join(link, 'lib', 'index.js'))) {
    problems.push(`profile link is present but does not reach the plugin: ${link}`);
  }

  // 2. The plugin's own files.
  for (const rel of REQUIRED_FILES) {
    if (!existsSync(join(pluginDir, rel))) problems.push(`missing file: ${rel}`);
  }

  // 3. package.json declarations.
  const pkg = readJson(join(pluginDir, 'package.json'));
  if (pkg === null) {
    problems.push('plugin package.json is missing or unparseable');
  } else {
    if (pkg.type !== 'module') problems.push(`package.json type is ${JSON.stringify(pkg.type)}, expected "module"`);
    if (pkg.exports === undefined) problems.push('package.json has no "exports" field - the loader will skip this bundle silently');
    if (pkg.dsh?.bundle?.patch === undefined) problems.push('package.json has no dsh.bundle.patch');
  }

  // 4. The profile still selects the bundle.
  const manifest = readJson(join(profileDir, 'package.json'));
  if (manifest === null) {
    problems.push('profile package.json is missing or unparseable');
  } else {
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    if (!bundles.includes('dsh-simple-notify')) {
      problems.push('the profile no longer lists dsh-simple-notify in dsh.profile.bundles');
    }
    if (manifest.dependencies?.['dsh-simple-notify'] === undefined) {
      problems.push('the profile no longer declares dsh-simple-notify as a dependency');
    }
  }

  // 5. Windows: can a toast from this AUMID be shown at all?
  if (!skipWindowsChecks && process.platform === 'win32') {
    const eligibility = checkToastEligibility({ aumid, appName });
    problems.push(...eligibility.problems);
  }

  return problems;
}

/**
 * Run the checks and return the informational notes alongside the problems,
 * so the caller can log what was verified and not only what broke.
 *
 * @returns {{problems: string[], info: string[]}}
 */
export function selfCheckReport(options) {
  const problems = selfCheck(options);
  const info = [];
  if (options.skipWindowsChecks !== true && process.platform === 'win32') {
    const eligibility = checkToastEligibility({
      aumid: options.aumid ?? 'com.deepseek.dsh',
      appName: options.appName ?? 'DeepSeek Harness',
    });
    info.push(...eligibility.info);
  }
  return { problems, info };
}

/**
 * Run the self-check at most once per local calendar day.
 *
 * @param options.profileDir - the profile to inspect
 * @param options.pluginDir - this plugin's own directory
 * @param options.stampPath - the file recording the last run's date
 * @param options.aumid - AppUserModelId the toaster uses (checked on Windows)
 * @param options.appName - Start-menu shortcut base name to look for
 * @param options.skipWindowsChecks - true to skip the Windows-only AUMID probe
 * @returns {{ran: boolean, problems: string[]}} ran is false when today's
 *   check has already happened.
 */
export function selfCheckOncePerDay({ profileDir, pluginDir, stampPath, aumid, appName, skipWindowsChecks }) {
  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local time

  try {
    if (existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === today) {
      return { ran: false, problems: [] };
    }
  } catch {
    // An unreadable stamp just means the check runs again.
  }

  const problems = selfCheck({ profileDir, pluginDir, aumid, appName, skipWindowsChecks });

  try {
    writeFileSync(stampPath, today, 'utf8');
  } catch {
    // A stamp we cannot write only costs a repeated check, never correctness.
  }

  return { ran: true, problems };
}
