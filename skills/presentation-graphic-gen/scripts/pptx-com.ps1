# pptx-com.ps1: optional PowerPoint check on Windows (pptx.mjs com calls it; nothing else needs it).
#   -Src <pptx> -PngDir <dir>   open read-only, report slides / notes / media shapes, export every slide to
#                               <dir>\NN.png (1920x1080)
# Safety: if POWERPNT.EXE is already running nothing is done (exit 2): the user's PowerPoint is never touched.
# The COM work runs in a child process; after -TimeoutSec it is killed together with only the POWERPNT.EXE it
# started (exit 3). Quit and release always.
param(
  [switch]$Worker,
  [string]$PidFile,
  [string]$Src,
  [string]$PngDir,
  [int]$TimeoutSec = 600
)
$ErrorActionPreference = 'Stop'
function Get-PptPids { @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }

if ($Worker) {
  $app = $null; $pres = $null; $rc = 1
  try {
    $before = Get-PptPids
    $app = New-Object -ComObject PowerPoint.Application
    $pptPid = @(Get-PptPids | Where-Object { $before -notcontains $_ })[0]
    Set-Content -Path $PidFile -Value $pptPid -Encoding ASCII
    Write-Output "[worker] PowerPoint $($app.Version) started, PID $pptPid"
    $pres = $app.Presentations.Open($Src, -1, 0, 0)
    $n = $pres.Slides.Count
    $notes = 0; $media = 0
    foreach ($s in $pres.Slides) {
      if ($s.HasNotesPage -ne 0) { $notes++ }
      foreach ($sh in $s.Shapes) { if ($sh.Type -eq 16) { $media++ } }
    }
    Write-Output "[worker] opened slides=$n notes=$notes media=$media"
    New-Item -ItemType Directory -Force -Path $PngDir | Out-Null
    for ($i = 1; $i -le $n; $i++) { $pres.Slides.Item($i).Export((Join-Path $PngDir ('{0:D2}.png' -f $i)), 'PNG', 1920, 1080) }
    Write-Output "[worker] exported $n PNG to $PngDir"
    $rc = 0
  } catch {
    Write-Output "[worker] ERROR: $($_.Exception.Message)"
  } finally {
    if ($pres) { try { $pres.Close() } catch { } ; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($pres) }
    if ($app) { try { $app.Quit() } catch { } ; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
  exit $rc
}

$running = Get-PptPids
if ($running.Count) { Write-Output "[com] STOP: POWERPNT.EXE is already running (PID $($running -join ', ')). Nothing was done."; exit 2 }
if (-not $Src -or -not (Test-Path $Src) -or -not $PngDir) { Write-Output "[com] ERROR: an existing -Src and a -PngDir are required"; exit 1 }
$Src = (Resolve-Path $Src).Path
$t0 = Get-Date
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("pgg-com-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$pidPath = Join-Path $tmp 'ppt.pid'; $outPath = Join-Path $tmp 'out.log'; $errPath = Join-Path $tmp 'err.log'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$wargs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Worker', '-PidFile', "`"$pidPath`"", '-Src', "`"$Src`"", '-PngDir', "`"$PngDir`"")
$w = Start-Process -FilePath $ps -PassThru -WindowStyle Hidden -RedirectStandardOutput $outPath -RedirectStandardError $errPath -ArgumentList $wargs
$null = $w.Handle
$done = $w.WaitForExit($TimeoutSec * 1000)
$pptPid = 0
if (Test-Path $pidPath) { $raw = (Get-Content $pidPath -Raw); if ($raw) { $pptPid = [int]($raw.Trim()) } }
$mine = @()
if ($pptPid) { $mine = @($pptPid) } else { $mine = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $t0 } | ForEach-Object { $_.Id }) }
$code = 0
if (-not $done) {
  Write-Output "[com] TIMEOUT after $TimeoutSec s. Killing worker $($w.Id) and PowerPoint $($mine -join ', ')."
  try { Stop-Process -Id $w.Id -Force -ErrorAction Stop } catch { }
  foreach ($id in $mine) { try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { } }
  $code = 3
} else { $w.WaitForExit(); $code = $w.ExitCode }
if (Test-Path $outPath) { Get-Content $outPath | ForEach-Object { Write-Output $_ } }
if ((Test-Path $errPath) -and (Get-Item $errPath).Length) { Get-Content $errPath | ForEach-Object { Write-Output "[worker stderr] $_" } }
foreach ($id in $mine) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and -not $p.WaitForExit(20000)) { try { Stop-Process -Id $id -Force -ErrorAction Stop; Write-Output "[com] PowerPoint $id did not exit after Quit; killed" } catch { } }
}
Write-Output ("[com] exit {0} in {1:N1} s" -f $code, ((Get-Date) - $t0).TotalSeconds)
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
exit $code
