# pptx-com.ps1: optional PowerPoint check on Windows (pptx.mjs com calls it; nothing else needs it).
#   -Src <pptx> -PngDir <dir>   open read-only, report slides / notes / media shapes, export every slide to
#                               <dir>\NN.png (1920x1080)
#   -Anim                       the editable deck's animation instead (pptx.mjs com --anim): open read-only with
#                               alerts off (a file PowerPoint wants to repair fails to open, or the run times out on
#                               its dialog), write <dir>\anim.json (every slide's main sequence: shape, effect type,
#                               trigger, delay, duration, exit, behaviors), save a copy as <dir>\resaved.pptx, then in
#                               an interactive desktop session run the slide show: per slide GetClickCount,
#                               FirstAnimationIsAutomatic and, after GotoClick(k) for k = 0..clicks and -ClickWaitSec,
#                               a capture of the show window <dir>\NN-cK.png. A session without a desktop (SSH) skips
#                               the show and says so in anim.json.
#   -Video                      with -Anim: on a temporary copy every click trigger becomes "after previous" with
#                               -GapSec more delay, then CreateVideo (1920x1080, 30 fps) writes <dir>\video.mp4
#   -Force                      write into a <dir> that is not empty (without it: nothing is done, exit 4)
# Safety: if POWERPNT.EXE is already running nothing is done (exit 2): the user's PowerPoint is never touched.
# The COM work runs in a child process; after -TimeoutSec it is killed together with only the POWERPNT.EXE it
# started (exit 3). Quit and release always. Windows PowerShell 5.1 syntax.
param(
  [switch]$Worker,
  [string]$PidFile,
  [string]$Src,
  [string]$PngDir,
  [switch]$Force,
  [switch]$Anim,
  [switch]$Video,
  [double]$ClickWaitSec = 4,
  [double]$GapSec = 1,
  [int]$TimeoutSec = 600
)
$ErrorActionPreference = 'Stop'
function Get-PptPids { @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }

# ---------- -Anim helpers (worker side) ----------
function Get-Effects($slide) {
  $seq = $slide.TimeLine.MainSequence
  $list = @()
  for ($i = 1; $i -le $seq.Count; $i++) {
    $e = $seq.Item($i)
    $types = @()
    for ($j = 1; $j -le $e.Behaviors.Count; $j++) { $types += [int]$e.Behaviors.Item($j).Type }
    $list += [ordered]@{ shape = $e.Shape.Name; effectType = [int]$e.EffectType; exit = [int]$e.Exit; trigger = [int]$e.Timing.TriggerType;
      delay = [double]$e.Timing.TriggerDelayTime; duration = [double]$e.Timing.Duration; behaviors = $types }
  }
  return ,$list
}
function Test-Desktop {
  if (-not [Environment]::UserInteractive) { return $false }
  return ((Get-Process -Id $PID).SessionId -ne 0)
}
function Save-Window($hwnd, $file) {
  if (-not ('PggWin' -as [type])) {
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public struct PggRect { public int L, T, R, B; } public static class PggWin { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out PggRect r); }'
  }
  $r = New-Object PggRect
  [void][PggWin]::GetWindowRect([IntPtr]$hwnd, [ref]$r)
  $w = $r.R - $r.L; $h = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size); $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $g.Dispose(); $bmp.Dispose() }
}
function Invoke-Show($pres, $dir) {
  $rows = @()
  $win = $pres.SlideShowSettings.Run()
  try {
    $view = $win.View
    for ($i = 1; $i -le $pres.Slides.Count; $i++) {
      $view.GotoSlide($i)
      Start-Sleep -Milliseconds 1500
      $clicks = [int]$view.GetClickCount()
      $auto = [bool]$view.FirstAnimationIsAutomatic()
      $shots = @()
      for ($k = 0; $k -le $clicks; $k++) {
        $view.GotoClick($k)
        Start-Sleep -Milliseconds ([int]($ClickWaitSec * 1000))
        $f = Join-Path $dir ('{0:D2}-c{1}.png' -f $i, $k)
        Save-Window $win.HWND $f
        $shots += (Split-Path $f -Leaf)
      }
      $rows += [ordered]@{ slide = $i; clicks = $clicks; firstAuto = $auto; captures = $shots }
    }
  } finally { try { $win.View.Exit() } catch { } }
  return ,$rows
}
function New-Video($app, $src, $dir) {
  $copy = Join-Path $dir 'video-source.pptx'
  Copy-Item -LiteralPath $src -Destination $copy -Force
  $p = $app.Presentations.Open($copy, 0, 0, 0)
  try {
    foreach ($s in $p.Slides) {
      $seq = $s.TimeLine.MainSequence
      for ($i = 1; $i -le $seq.Count; $i++) { $t = $seq.Item($i).Timing; if ($t.TriggerType -eq 1) { $t.TriggerType = 3; $t.TriggerDelayTime = $t.TriggerDelayTime + $GapSec } }
      $s.SlideShowTransition.AdvanceOnTime = -1; $s.SlideShowTransition.AdvanceTime = $GapSec
    }
    $mp4 = Join-Path $dir 'video.mp4'
    $p.CreateVideo($mp4, -1, $GapSec, 1080, 30, 85)
    $t0 = Get-Date
    while ($p.CreateVideoStatus -eq 1 -or $p.CreateVideoStatus -eq 2) { if (((Get-Date) - $t0).TotalSeconds -gt ($TimeoutSec - 60)) { throw 'CreateVideo did not finish' }; Start-Sleep -Seconds 1 }
    if ($p.CreateVideoStatus -ne 3) { throw "CreateVideo status $($p.CreateVideoStatus)" }
    return [ordered]@{ file = 'video.mp4'; gapSec = $GapSec; seconds = ((Get-Date) - $t0).TotalSeconds }
  } finally { $p.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($p); Remove-Item -LiteralPath $copy -Force -ErrorAction SilentlyContinue }
}
function Invoke-Anim($app, $dir) {
  $app.DisplayAlerts = 1
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $pres = $app.Presentations.Open($Src, -1, 0, -1)
  try {
    $out = [ordered]@{ version = $app.Version; opened = $true; slides = @() }
    foreach ($s in $pres.Slides) { $out.slides += [ordered]@{ slide = [int]$s.SlideIndex; effects = (Get-Effects $s) } }
    Write-Output "[worker] opened slides=$($pres.Slides.Count)"
    $pres.SaveCopyAs((Join-Path $dir 'resaved.pptx'))
    if (Test-Desktop) { $out.show = Invoke-Show $pres $dir } else { $out.show = $null; $out.showSkipped = 'no interactive desktop session (SSH or a service): the slide show and captures were not run' }
    if ($Video) { $out.video = New-Video $app $Src $dir }
    ($out | ConvertTo-Json -Depth 8) | Set-Content -Path (Join-Path $dir 'anim.json') -Encoding UTF8
    Write-Output "[worker] wrote anim.json"
  } finally { try { $pres.Close() } catch { } ; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($pres) }
}

if ($Worker) {
  $app = $null; $pres = $null; $rc = 1
  try {
    $before = Get-PptPids
    $app = New-Object -ComObject PowerPoint.Application
    $pptPid = @(Get-PptPids | Where-Object { $before -notcontains $_ })[0]
    Set-Content -Path $PidFile -Value $pptPid -Encoding ASCII
    Write-Output "[worker] PowerPoint $($app.Version) started, PID $pptPid"
    if ($Anim) { Invoke-Anim $app $PngDir; $rc = 0 } else {
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
    }
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
if (-not $Force -and (Test-Path -LiteralPath $PngDir) -and @(Get-ChildItem -LiteralPath $PngDir -Force).Count) { Write-Output "[com] STOP: $PngDir is not empty; not overwriting (use -Force). Nothing was done."; exit 4 }
$Src = (Resolve-Path $Src).Path
$t0 = Get-Date
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("pgg-com-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$pidPath = Join-Path $tmp 'ppt.pid'; $outPath = Join-Path $tmp 'out.log'; $errPath = Join-Path $tmp 'err.log'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$wargs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Worker', '-PidFile', "`"$pidPath`"", '-Src', "`"$Src`"", '-PngDir', "`"$PngDir`"", '-TimeoutSec', $TimeoutSec)
if ($Anim) { $wargs += @('-Anim', '-ClickWaitSec', $ClickWaitSec, '-GapSec', $GapSec) }
if ($Video) { $wargs += '-Video' }
$w = Start-Process -FilePath $ps -PassThru -WindowStyle Hidden -RedirectStandardOutput $outPath -RedirectStandardError $errPath -ArgumentList $wargs
$null = $w.Handle
$done = $w.WaitForExit($TimeoutSec * 1000)
$pptPid = 0
if (Test-Path $pidPath) { $raw = (Get-Content $pidPath -Raw); if ($raw) { $pptPid = [int]($raw.Trim()) } }
$mine = @()
if ($pptPid) { $mine = @($pptPid) } else { $mine = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $t0 } | ForEach-Object { $_.Id }) }
$code = 0
if (-not $done) {
  Write-Output "[com] TIMEOUT after $TimeoutSec s (a PowerPoint dialog, such as the repair prompt, may have been open). Killing worker $($w.Id) and PowerPoint $($mine -join ', ')."
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
