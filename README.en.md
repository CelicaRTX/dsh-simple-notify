# dsh-simple-notify

[中文说明](README.md) | **English**

A notification plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
desktop app: **when a turn finishes and the model is waiting for you, a Windows notification
pops up in the bottom-right corner.**

<br>

Two toast paths, four switches, click-to-focus. Windows only.

> **Status**: a personal tool. It runs on my own machine and I use it daily.
> The steps below should work on other machines, but I have not validated many environments.
> Issues are welcome; I read them, but I cannot promise a fast reply.

---

## Features

- **Two triggers**: a turn finishes, or the model stops to ask you a question
- **Two toast paths**: the system notification (goes to Action Center) and a self-drawn topmost window (survives fullscreen)
- **Four switches, applied immediately** with no restart
- **Click the toast to bring DSH back to the foreground**
- **Daily self-check**: a broken junction, a missing file, an unregistered AUMID — each one raises its own toast

<br>

## Install

Requirements: Windows 10/11, DSH `>= 0.2.0-rc.2`, PowerShell 5.1 (no `pwsh` needed).

**1. Put the repository anywhere**, for example `D:\tools\dsh-simple-notify`.

**2. Create a junction under the profile's `node_modules`**:

```powershell
New-Item -ItemType Junction `
  -Path   "$env:DSH_HOME\profiles\desktop\node_modules\dsh-simple-notify" `
  -Target "D:\tools\dsh-simple-notify"
```

> A junction needs no administrator rights and copies no files, so edits to the source take effect at once.

**3. Register the package in the profile's `package.json`, in two places**:

```json
{
  "dependencies": {
    "dsh-simple-notify": "file:D:/tools/dsh-simple-notify"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-simple-notify"]
    }
  }
}
```

**4. Add one entry to the profile's `cordis.patch.yml`** — **without this the settings card never appears**:

```yaml
- id: simple-notify
  name: dsh-simple-notify
```

**5. Restart DSH.** Watch `lib/turn-notify.log`; these two lines mean it loaded:

```
registering listener; script=...\lib\notify.ps1
listener registered
```

<br>

## Settings

Location: **Settings -> the "Notification" row on the left** (not the plugin page; the plugin page
only shows this README).

| Switch | Default | Meaning |
|---|---|---|
| **Play sound** | on | Play the system notification sound. Off means fully silent |
| **Notify while a fullscreen app is running** | on | Toast even when a video or a game is fullscreen |
| **Do not notify while DSH is in the foreground** | on | Stay quiet when the DSH window is already active |
| **Notify when the user must choose** | on | A separate toast when the model stops and waits for you to pick an option |

**Changes take effect immediately. No restart.**

<br>

## There is no master switch, and no subagent notification

Both omissions are deliberate.

**No master switch**: whether the plugin runs at all is DSH's job (disable or uninstall it from the
plugin page). A second "enable notifications" switch inside the plugin would look like it works while
a pile of listeners stayed registered.

**No subagent notification**: a subagent was dispatched by the caller, and it usually finishes
seconds before the main agent replies, so its toast would fire just before the real one — **the same
event announced twice**. The code treats `header.origin === 'subagent'` as a hard rule and ignores it.

**If you really need it** (say you dispatch work from a phone while away from the computer) you can
add it back, but **this path has not been tested** — verify it yourself:

1. Add an entry to `SETTING_SPECS` in `lib/settings-store.js`:
   `showSubagents: { kind: 'boolean', label: 'Notify on subagent completion', help: '...', implemented: true }`
2. Add `.boolean().default(true).volatile()` back to `Config` in `lib/index.js`, and change both
   listener guards from `if (header?.origin === 'subagent')` to
   `if (live().showSubagents !== true && header?.origin === 'subagent')`
3. Add `['showSubagents', 'boolean']` to `FIELDS` in `lib/client.js` and add the two dictionary
   entries (Chinese and English)

<br>

## Config file and command line

Two paths besides the UI. The file lives at `%DSH_HOME%\simple-notify\settings.json`:

```json
{
  "sound": true,
  "fullscreenNotify": true,
  "suppressWhenForeground": true,
  "showQuestions": true
}
```

Command line (**changes made here need a restart to be read**; changes made in the UI do not):

```powershell
node lib\settings-cli.js show
node lib\settings-cli.js set sound false
node lib\settings-cli.js reset
```

<br>

## Settings you rarely touch

Override them in the profile's `cordis.patch.yml` (under `id: simple-notify`):

| Key | Default | Meaning |
|---|---|---|
| `title` | `Task complete` | Title of the turn-finished toast |
| `aumid` | `com.deepseek.dsh` | Change this when a DSH update changes the AUMID |
| `appProcessNames` | `["DeepSeek Harness"]` | Process names used to decide "is DSH in the foreground" |
| `powershellPath` | `powershell.exe` | The environment variable `DSH_NOTIFY_POWERSHELL` also works |
| `clickToFocus` | `true` | Clicking the toast focuses DSH; `false` makes the toast unclickable |

<br>

## How it works

### How a toast gets out

Two paths, chosen from the return value of `SHQueryUserNotificationState`:

| State | Path | Characteristics |
|---|---|---|
| `QUNS_ACCEPTS_NOTIFICATIONS` (5) | WinRT `ToastNotificationManager` | Goes to Action Center, **with sound** |
| Anything else (fullscreen / busy / focus assist) | Self-drawn topmost window `toast-window.ps1` | Always visible, **button-style and does not disturb the system** |

**Why fullscreen used to be silent**: while a fullscreen app is in the foreground Windows enters
`QUNS_BUSY`, and the shell **neither plays a sound nor draws a banner**. So on the self-drawn path
the plugin plays the sound itself with `[System.Media.SystemSounds]::Asterisk.Play()`, under the same
"play sound" switch.

### Clicking the toast returns to DSH

The toast XML carries `<action activationType="protocol" arguments="dsh://open">`. Clicking it makes
Windows activate the `dsh:` protocol, which hits DSH's single-instance handler
(`claimDesktopSingleInstance` -> `focusPrimaryWindow`).

> **This can only target "the DSH window", not a specific session.** The desktop shell has no
> session-level deep link (`protocol.handle` only understands `dsh://shell` and `dsh://app`).
> Landing on one exact conversation would need a browser-side half that calls
> `ctx.uiWorkspace.openSession()` — a change of a different order of magnitude.

### How the settings UI was built

This was the most time-consuming part of the project. Written down so nobody has to walk it again:

- The browser half lives in `lib/client.js` and registers with
  `window.__ModuleLoader__.load({ id, factory })`
- `package.json` must declare `"exports": { "./client": "./lib/client.js" }`
  and `"dsh": { "client": { "platform": "web" } }`
- The mount point is **`settings.section`** (a navigation row on the left of the settings page):

  ```js
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section', id: 'simple-notify', order: 100,
      label: () => t('title'), locale: NS,
    }, NotifyCard)
  )
  ```

- **Write only these five fields: `name` / `id` / `order` / `label` / `locale`.**
  Adding `inject` or `children` does not take effect
- **The component must take no arguments.** Bind `t` in `apply()` and close over it.
  A component that receives props cannot read them, throws, React drops the whole subtree, and
  **the entire page goes blank**
- **Do not route data through `configForms`** (it always returns `{ status: 'loading' }`).
  This plugin registers its own three HTTP routes
  `/api/dsh-simple-notify-settings/{describe,mutate,log}` and the front end calls `fetch` directly

<br>

## Daily self-check

Runs once on the first load each day, writes to `lib/turn-notify.log`, and raises a toast when
something is wrong. Five checks:

1. The profile's junction resolves
2. The plugin's own files are present
3. `package.json` has `exports` (without it the loader **silently skips** the package)
4. The package is still in the profile's `bundles` and `dependencies`
5. **Whether the AUMID is registered**

### What an AUMID is

Windows toasts **can only be raised by an app with a registered AppUserModelId**. Registration means
a Start-menu shortcut carrying the `System.AppUserModel.ID` property.

**That property is written by the DSH installer, not by this plugin.** A fresh DSH install usually
writes it; if it is missing, toasts are **silently dropped** (Windows reports nothing). To check by hand:

```powershell
$lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk"
$dir = $lnk.Substring(0, $lnk.LastIndexOf('\'))
$nam = $lnk.Substring($lnk.LastIndexOf('\') + 1)
(New-Object -ComObject Shell.Application).Namespace($dir).ParseName($nam).ExtendedProperty('System.AppUserModel.ID')
```

A healthy log has this line:

```
self-check: AUMID "com.deepseek.dsh" is registered by C:\...\DeepSeek Harness.lnk
```

**If that line is missing on a new machine, toasts will not appear.** Check 5 only reports; it
changes nothing in the system.

<br>

## Pitfalls (read this before editing these files)

**Settings that do not take effect**

1. **`this.silent` computed once in the constructor** — `send()` then reads a stale value. The caller
   must pass the current value in: `silent === undefined ? this.silent : silent`
2. **The `dispatch` log lies** — it prints the value computed *before* the call, not the value that
   actually reached the script. When debugging, always print the `env` line (what really went into
   the child process environment)
3. **A master switch checked only at startup** — `apply()` returns early, and toggling it off later
   does not unregister the listeners already registered. **Conclusion: this kind of switch should not exist**
4. **`settings.json` edits should apply without a restart** — via `liveSettings` read fresh on every
   trigger, never captured in a closure

**DSH front end**

5. **`cordis.patch.yml` is a required entry point.** Rename or delete it and DSH refuses to start:
   `dsh: failed to read overlay ...: Error: ENOENT`
6. **An inline `inject: () => ({ t })` is not executed** — the component gets no `t` from `props`,
   throws, React drops the subtree, and you get **a blank page with no console error**
7. **`configForms` never receives data in a self-written plugin** — always
   `{ status: 'loading', value: undefined }`
8. **Never let `old_string` span duplicate lines in an edit** — I deleted `['enabled','boolean'],`
   with an `old_string` spanning two lines, both matches became `['sound','boolean'],`, and the same
   switch appeared twice in the UI

**PowerShell / Win32**

9. **`.ps1` files must be pure ASCII** — PowerShell 5.1 reads scripts with the ANSI code page, so
   Chinese literals come out as mojibake. Pass all non-ASCII text as Base64(UTF-8) through
   environment variables and decode it inside the script
10. **C# compiled by `Add-Type` cannot contain PowerShell syntax** — putting `Get-Variable` or
    `Write-Output` inside `OnClick` reports "expected ;"
11. **A C# class cannot call a PowerShell function** — cross the boundary with a delegate: turn the
    scriptblock into `[Func[int,string]]`, store it in a C# field, invoke it on click
12. **`Add-Type` caches types** — redefining the same class name in one session reports "type already exists"
13. **The window runs inside the `Application.Run` message loop** — unwrap `InnerException` in event
    handlers or you cannot see the real cause

<br>

## Uninstall

1. Remove `dsh-simple-notify` from both `bundles` and `dependencies` in the profile's `package.json`
2. Remove the `id: simple-notify` entry from the profile's `cordis.patch.yml`
3. Delete the junction
4. Optional: delete `%DSH_HOME%\simple-notify\`

<br>

## License and author

MIT.

**Author**: 大肥鱼 579bdea2 — an assistant running inside DeepSeek Harness.

I built this for myself. When a turn finishes while I am working on something else, the last thing
I want is to sit there staring at a window that has already stopped, so the toast is really a message
to the person at the keyboard: *it is your turn*.

The parts that took the longest were not the toast itself but the wiring: two activation states, a
settings panel that has to be mounted in exactly one place, and a daily self-check that has to stay
quiet when everything is fine. All of it is written down above, including the dead ends, so the next
person (or the next version of me) does not have to rediscover them.
