# dsh-simple-notify health check.
#
# Read-only. Verifies that the pieces the notification plugin depends on are
# still in place. It changes nothing and installs nothing.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File check-health.ps1
#
# Exit code 0 = everything intact, 1 = something is broken.

$ErrorActionPreference = 'Continue'

if (-not $env:DSH_HOME) { $env:DSH_HOME = 'D:\DEEPSEEKHARNESS\.dsh' }
$Profile   = Join-Path $env:DSH_HOME 'profiles\desktop'
$PluginSrc = $PSScriptRoot
$Link      = Join-Path $Profile 'node_modules\dsh-simple-notify'

$problems = @()
$notes    = @()

function Ok   ($m) { Write-Host ("  [ok]   " + $m) -ForegroundColor Green }
function Bad  ($m) { Write-Host ("  [FAIL] " + $m) -ForegroundColor Red;    $script:problems += $m }
function Info ($m) { Write-Host ("  [info] " + $m) -ForegroundColor Gray }
function Warn ($m) { Write-Host ("  [warn] " + $m) -ForegroundColor Yellow; $script:notes += $m }

Write-Host ''
Write-Host '=== 1. profile directory ===' -ForegroundColor Cyan
if (Test-Path $Profile) {
  Ok "profile exists: $Profile"
} else {
  Bad "profile directory is missing: $Profile"
}

$manifestPath = Join-Path $Profile 'package.json'
$manifest = $null
if (Test-Path $manifestPath) {
  try {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    Ok 'profile package.json parses'
  } catch {
    Bad "profile package.json does not parse: $($_.Exception.Message)"
  }
} else {
  Bad 'profile package.json is missing'
}

Write-Host ''
Write-Host '=== 2. plugin registered in the profile ===' -ForegroundColor Cyan
if ($null -ne $manifest) {
  $dep = $manifest.dependencies.'dsh-simple-notify'
  if ($dep) {
    Ok "declared as a dependency: $dep"
  } else {
    Bad 'dsh-simple-notify is NOT in package.json dependencies'
  }

  $bundles = @($manifest.dsh.profile.bundles)
  if ($bundles -contains 'dsh-simple-notify') {
    Ok "listed in dsh.profile.bundles (position $([array]::IndexOf($bundles, 'dsh-simple-notify') + 1) of $($bundles.Count))"
  } else {
    Bad 'dsh-simple-notify is NOT in dsh.profile.bundles'
  }
}

Write-Host ''
Write-Host '=== 3. the junction into node_modules ===' -ForegroundColor Cyan
if (Test-Path $Link) {
  $item = Get-Item $Link -Force
  Ok "link present ($($item.LinkType))"
  Info "target: $($item.Target)"
  if ($item.LinkType -eq 'Junction' -and $item.Target -ne $PluginSrc) {
    Bad "junction points somewhere unexpected: $($item.Target)"
  }
} else {
  Bad "node_modules\dsh-simple-notify is missing (the junction was removed or the target moved)"
}

Write-Host ''
Write-Host '=== 4. plugin files ===' -ForegroundColor Cyan
$expected = @{
  'package.json'       = $null
  'cordis.patch.yml'   = $null
  'lib\index.js'       = $null
  'lib\notify.ps1'     = $null
}
foreach ($rel in $expected.Keys) {
  $p = Join-Path $PluginSrc $rel
  if (Test-Path $p) {
    $f = Get-Item $p
    Ok ("{0,-20} {1,6} bytes   modified {2}" -f $rel, $f.Length, $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
  } else {
    Bad "missing file: $rel"
  }
}

Write-Host ''
Write-Host '=== 5. package.json declarations ===' -ForegroundColor Cyan
$pkgPath = Join-Path $PluginSrc 'package.json'
if (Test-Path $pkgPath) {
  try {
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    if ($pkg.type -eq 'module') { Ok 'type = module' } else { Bad "type is '$($pkg.type)', expected 'module'" }
    if ($pkg.exports) { Ok 'exports field present (required for bare-specifier import)' } else { Bad 'exports field is MISSING - the loader will fail silently' }
    if ($pkg.dsh.bundle.patch) { Ok "dsh.bundle.patch = $($pkg.dsh.bundle.patch)" } else { Bad 'dsh.bundle.patch is missing' }
  } catch {
    Bad "plugin package.json does not parse: $($_.Exception.Message)"
  }
}

Write-Host ''
Write-Host '=== 6. the PowerShell toast script is pure ASCII ===' -ForegroundColor Cyan
$ps1 = Join-Path $PluginSrc 'lib\notify.ps1'
if (Test-Path $ps1) {
  $bytes = [System.IO.File]::ReadAllBytes($ps1)
  $nonAscii = @($bytes | Where-Object { $_ -gt 127 })
  if ($nonAscii.Count -eq 0) {
    Ok 'no non-ASCII bytes (Chinese text travels as Base64, as required)'
  } else {
    Bad "$($nonAscii.Count) non-ASCII byte(s) found - the toast text will render as garbage"
  }
}

Write-Host ''
Write-Host '=== 7. is DSH running, and does it own the foreground? ===' -ForegroundColor Cyan
$procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
  Info 'DSH is not running'
} else {
  $withWindow = @($procs | Where-Object { $_.MainWindowHandle -ne 0 })
  Ok "DSH running: $($procs.Count) process(es), $($withWindow.Count) with a window"
  foreach ($p in $withWindow) { Info "window pid $($p.Id): $($p.MainWindowTitle)" }
}

$sig = @'
using System;
using System.Runtime.InteropServices;
public class HealthFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
try {
  if (-not ('HealthFg' -as [type])) { Add-Type -TypeDefinition $sig -ErrorAction Stop | Out-Null }
  $h = [HealthFg]::GetForegroundWindow()
  $fgp = [uint32]0
  [void][HealthFg]::GetWindowThreadProcessId($h, [ref]$fgp)
  $fgName = (Get-Process -Id $fgp -ErrorAction SilentlyContinue).ProcessName
  $dshInFront = @($procs | ForEach-Object { [int]$_.Id }) -contains [int]$fgp
  Info "foreground: $fgName (pid $fgp)"
  if ($dshInFront) {
    Info 'DSH has focus -> a toast would be SUPPRESSED right now (correct behaviour)'
  } else {
    Info 'DSH does not have focus -> a toast would be SHOWN right now'
  }
} catch {
  Warn "could not read the foreground window: $($_.Exception.Message)"
}

Write-Host ''
Write-Host '=== 8. last plugin activity ===' -ForegroundColor Cyan
$log = Join-Path $PluginSrc 'lib\turn-notify.log'
if (Test-Path $log) {
  $f = Get-Item $log
  Ok "log present, last written $($f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
  $tail = Get-Content $log -Tail 4
  foreach ($line in $tail) { Info $line }
  $age = (Get-Date) - $f.LastWriteTime
  if ($age.TotalHours -gt 24) {
    Warn "no plugin activity for $([int]$age.TotalHours) hour(s) - the plugin may not be loading"
  }
} else {
  Warn 'no log yet - the plugin has not run since the last restart (normal right after a restart)'
}

Write-Host ''
Write-Host '=== summary ===' -ForegroundColor Cyan
if ($problems.Count -eq 0) {
  Write-Host '  ALL CHECKS PASSED' -ForegroundColor Green
} else {
  Write-Host "  $($problems.Count) PROBLEM(S):" -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "    - $p" -ForegroundColor Red }
}
if ($notes.Count -gt 0) {
  Write-Host "  $($notes.Count) note(s):" -ForegroundColor Yellow
  foreach ($n in $notes) { Write-Host "    - $n" -ForegroundColor Yellow }
}
Write-Host ''

if ($problems.Count -gt 0) { exit 1 } else { exit 0 }
