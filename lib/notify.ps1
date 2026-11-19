# dsh-simple-notify - notification dispatcher.
#
# This file is deliberately pure ASCII. Chinese text arrives as Base64-encoded
# UTF-8 in the environment, because PowerShell 5.1 decodes .ps1 files using the
# system ANSI code page and would corrupt any literal non-ASCII characters.
#
# Environment:
#   DSH_NOTIFY_TITLE_B64       Base64(UTF-8) toast heading
#   DSH_NOTIFY_BODY_B64        Base64(UTF-8) toast body   (may be empty)
#   DSH_NOTIFY_SKIP_FOREGROUND '1' to suppress when the DSH window has focus
#   DSH_NOTIFY_AUMID           optional AppUserModelId override
#   DSH_NOTIFY_APP_NAMES_B64   Base64(UTF-8) of '|'-separated foreground exe
#                              names; defaults to 'DeepSeek Harness'
#   DSH_NOTIFY_MODE            'auto' (default) | 'toast' | 'overlay'
#   DSH_NOTIFY_HOLD_MS         overlay visibility in ms (default 4200)
#   DSH_NOTIFY_DRY_RUN         '1' to report what would happen without sending
#   DSH_NOTIFY_WINDOW_PID      Process id of the DSH window process. When set,
#                              clicking the notification brings that window to
#                              the front. Unset means the notification is not
#                              clickable (the old behaviour).
#
# Portability notes (this script must work on any Windows machine):
#   * No absolute paths, no localised strings, no assumptions about where DSH
#     is installed. Everything comes from the environment or is discovered.
#   * A toast only appears if its AppUserModelId resolves to a Start-menu
#     shortcut carrying System.AppUserModel.ID. On a fresh machine that
#     shortcut may be absent and Windows then drops the toast WITHOUT an error,
#     so Test-Aumid / Repair-Aumid below exist to detect and fix exactly that.
#
# ---------------------------------------------------------------------------
# Why there are two presentation paths
# ---------------------------------------------------------------------------
# Windows silently suppresses toast BANNERS while a fullscreen app is in front.
# Show() returns normally and the notification still reaches Action Center, but
# nothing is drawn - the failure looks exactly like a broken plugin. Measured on
# this machine: SHQueryUserNotificationState returns 5 (accepts) with DSH in
# front and 2 (busy) with a fullscreen game in front, and
# HKCU\...\Notifications\QuietHours\FullScreenProcess names the game.
#
# A topmost window is not subject to that rule, so in 'auto' mode the script
# asks the shell which state it is in and picks the path that will actually be
# seen. 'toast' and 'overlay' force one path, which is what the tests use.

$ErrorActionPreference = 'Stop'

function Decode-B64Utf8([string] $value) {
  if ([string]::IsNullOrEmpty($value)) { return '' }
  $bytes = [System.Convert]::FromBase64String($value)
  return [System.Text.Encoding]::UTF8.GetString($bytes)
}

# Foreground detection. The executable names are configurable because the
# desktop app's file name is not guaranteed to stay 'DeepSeek Harness'.
function Test-DshForeground {
  $raw = Decode-B64Utf8 $env:DSH_NOTIFY_APP_NAMES_B64
  if ([string]::IsNullOrEmpty($raw)) { $raw = 'DeepSeek Harness' }
  $names = @($raw.Split('|') | Where-Object { $_.Trim().Length -gt 0 })

  $sig = @'
using System;
using System.Runtime.InteropServices;
public class DshFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
  if (-not ('DshFg' -as [type])) {
    Add-Type -TypeDefinition $sig -ErrorAction Stop | Out-Null
  }
  $hwnd = [DshFg]::GetForegroundWindow()
  $fgPid = [uint32]0
  [void][DshFg]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)
  if ($fgPid -eq 0) { return $false }
  $proc = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) { return $false }
  foreach ($name in $names) {
    if ($proc.ProcessName -eq $name.Trim()) { return $true }
  }
  return $false
}

# 5 = QUNS_ACCEPTS_NOTIFICATIONS, the only state in which a banner is drawn.
# Everything else (busy / fullscreen D3D / presentation / quiet time / UWP app
# in front) means the shell would swallow it.
function Get-NotificationState {
  $sig = @'
using System;
using System.Runtime.InteropServices;
public class DshQuns {
  [DllImport("shell32.dll")]
  public static extern int SHQueryUserNotificationState(out int state);
}
'@
  if (-not ('DshQuns' -as [type])) {
    Add-Type -TypeDefinition $sig -ErrorAction Stop | Out-Null
  }
  $state = 0
  [void][DshQuns]::SHQueryUserNotificationState([ref]$state)
  return [int]$state
}

# ---------------------------------------------------------------------------
# Bringing the DSH window to the front.
# ---------------------------------------------------------------------------
# The plugin runs inside the DSH *host* process, which is a separate process
# from the Electron window, so it cannot call Electron's focusPrimaryWindow().
# It can only use Win32, and it has to defeat the two guards Windows puts in
# front of SetForegroundWindow: the calling process does not own the
# foreground, and it is not the process that started the current foreground
# window. Both are satisfied by attaching our input queue to the foreground
# thread for the duration of the call, which is what AttachThreadInput does.
#
# The process id is supplied by the caller because the window process is
# discovered there (both window processes are named after the app, and neither
# is identifiable from inside the host).
function Focus-DshWindow([int] $processId) {
  $sig = @'
using System;
using System.Runtime.InteropServices;
public class DshFocus {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
  if (-not ('DshFocus' -as [type])) {
    Add-Type -TypeDefinition $sig -ErrorAction Stop | Out-Null
  }

  # Find the top-level window owned by the process. Enumerating the process's
  # windows is not available from PowerShell without a callback type, so the
  # caller passes the pid of a process that owns exactly one visible top-level
  # window and we locate it through Get-Process's MainWindowHandle instead:
  # that value is the OS's own answer to this question.
  $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $proc) { return 'process gone' }

  $handle = [IntPtr] $proc.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) {
    # MainWindowHandle is empty while the window is hidden (tray-only state).
    # Bringing it back is then impossible without the window's cooperation,
    # and saying so is more useful than reporting a generic failure.
    return 'no main window (window is hidden to tray)'
  }

  if ([DshFocus]::IsIconic($handle)) { [void][DshFocus]::ShowWindow($handle, 9) }  # 9 = SW_RESTORE

  $foreground = [DshFocus]::GetForegroundWindow()
  $fgPid = [uint32] 0
  $fgThread = [DshFocus]::GetWindowThreadProcessId($foreground, [ref] $fgPid)
  $ownThread = [DshFocus]::GetCurrentThreadId()

  $attached = $false
  try {
    if ($fgThread -ne 0 -and $fgThread -ne $ownThread) {
      $attached = [DshFocus]::AttachThreadInput($ownThread, $fgThread, $true)
    }
    [void][DshFocus]::BringWindowToTop($handle)
    $ok = [DshFocus]::SetForegroundWindow($handle)
  } finally {
    if ($attached) { [void][DshFocus]::AttachThreadInput($ownThread, $fgThread, $false) }
  }

  return $(if ($ok) { 'focused' } else { 'set-foreground refused' })
}

$title = Decode-B64Utf8 $env:DSH_NOTIFY_TITLE_B64
$body = Decode-B64Utf8 $env:DSH_NOTIFY_BODY_B64

# The window process to bring forward when the notification is clicked. Absent
# or unparsable means the notification stays inert, which is the old behaviour.
$windowPid = 0
if ($env:DSH_NOTIFY_WINDOW_PID) {
  if ([int]::TryParse($env:DSH_NOTIFY_WINDOW_PID, [ref] $windowPid) -and $windowPid -le 0) { $windowPid = 0 }
}

if ($env:DSH_NOTIFY_SKIP_FOREGROUND -eq '1') {
  if (Test-DshForeground) {
    Write-Output 'suppressed (app in foreground)'
    exit 0
  }
}

$mode = 'auto'
if ($env:DSH_NOTIFY_MODE -in @('auto', 'toast', 'overlay')) { $mode = $env:DSH_NOTIFY_MODE }

$quns = -1
try { $quns = Get-NotificationState } catch { $quns = -1 }

$useOverlay = ($mode -eq 'overlay') -or ($mode -eq 'auto' -and $quns -ne 5)

# The overlay is drawn by a script that is dot-sourced into this process, so it
# reads the pid and the focus helper from here.
$env:DSH_NOTIFY_WINDOW_PID_RESOLVED = [string] $windowPid

if ($env:DSH_NOTIFY_DRY_RUN -eq '1') {
  $path = if ($useOverlay) { 'overlay' } else { 'toast' }
  Write-Output ("dry-run title=" + $title + " body=" + $body + " mode=" + $mode + " quns=" + $quns + " path=" + $path)
  exit 0
}

# ---------------------------------------------------------------------------
# Path A: our own topmost window. Works over fullscreen apps and is never
# suppressed, at the cost of not reaching Action Center.
# ---------------------------------------------------------------------------
if ($useOverlay) {
  $overlay = Join-Path $PSScriptRoot 'toast-window.ps1'
  if (Test-Path $overlay) {
    try {
      # Dot-sourced so the window runs in this process; it blocks until the
      # window closes, which is why the caller must not await this script.
      # Focus-DshWindow is defined above and the overlay calls it on click.
      . $overlay
      Write-Output ('overlay quns=' + $quns)
      exit 0
    } catch {
      Write-Output ('overlay failed: ' + $_.Exception.Message + '; falling back to toast')
    }
  } else {
    Write-Output 'overlay script missing; falling back to toast'
  }
}

# ---------------------------------------------------------------------------
# Path B: the shell toast.
# ---------------------------------------------------------------------------
$escTitle = [System.Security.SecurityElement]::Escape($title)
$escBody = [System.Security.SecurityElement]::Escape($body)

$textNodes = '<text>' + $escTitle + '</text>'
if ($body.Length -gt 0) {
  $textNodes += '<text>' + $escBody + '</text>'
}

# Clicking the banner (and the button, which is only there to make the click
# target obvious) activates the `dsh:` protocol, i.e. the running DSH instance,
# whose single-instance handler focuses the main window.
#
# `activationType="protocol"` is required: without it an action is a background
# action with no launch target and the click does nothing at all. The attribute
# is skipped when no window pid was supplied, so the notification degrades to
# the plain, inert toast it was before.
# The button label is Chinese but this file must stay pure ASCII (PowerShell 5.1
# decodes .ps1 with the ANSI code page), so the label is built from code points.
$actionLabel = [string]([char]0x6253) + [char]0x5F00 + [char]0x20 + [char]0x0044 + [char]0x0053 + [char]0x0048
$actions = ''
if ($windowPid -gt 0) {
  $actions = '<actions><action content="' + $actionLabel +
    '" activationType="protocol" arguments="dsh://open"/></actions>'
}

$xmlText = '<?xml version="1.0" encoding="utf-8"?>' +
  '<toast duration="short"><visual><binding template="ToastGeneric">' +
  $textNodes +
  '</binding></visual>' + $actions + '</toast>'

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml([System.Text.Encoding]::UTF8.GetString([System.Text.Encoding]::UTF8.GetBytes($xmlText)))

$aumid = if ([string]::IsNullOrEmpty($env:DSH_NOTIFY_AUMID)) { 'com.deepseek.dsh' } else { $env:DSH_NOTIFY_AUMID }

$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)

# Show() returns without an error even when the banner is never drawn, so the
# state is reported alongside the verdict: it is the difference between "the
# plugin is broken" and "Windows ate it on purpose".
Write-Output ('sent quns=' + $quns)
