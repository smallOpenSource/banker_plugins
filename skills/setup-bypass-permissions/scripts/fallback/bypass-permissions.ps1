# setup-bypass-permissions step 3 on Windows, for when node cannot run the main script.
#
#   powershell -NoProfile -File bypass-permissions.ps1 on --yes   set permissions.defaultMode = "bypassPermissions"
#   powershell -NoProfile -File bypass-permissions.ps1 off        remove that key (Claude Code's default start mode)
#
# The file is <config>\settings.json, <config> being $env:CLAUDE_CONFIG_DIR or %USERPROFILE%\.claude.
# Every other key stays, and so does a BOM. `on` keeps the text from before in
# settings.json.bypass-permissions.bak; a second `on` finds the mode set and writes nothing. Both files are
# replaced whole through a temp file, so a stop partway leaves the old text. Paths are taken literally:
# [ and ] in a folder name are not wildcards. Only the node script's `off` knows what `on` replaced;
# this `off` removes the key.
#
# `on` refuses (exit 1, nothing written) when managed policy (managed-settings.json or its
# managed-settings.d drop-ins) or the settings file itself sets permissions.disableBypassPermissionsMode,
# for a file that is not a JSON object, for a policy file or folder this account cannot read, and on a
# machine with no Claude Code config folder.
#
# Exit status: 0 done, or nothing to do. 1 refused. 2 unexpected error. 3 this account may not write the
# file or its folder. Every result ends with the line `settings file: <path>` on stdout.
# Windows PowerShell 5.1 or PowerShell 7. ASCII only: Windows PowerShell 5.1 reads a script without a BOM
# in the ANSI code page.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Off
$Mode = 'bypassPermissions'
$Utf8 = New-Object System.Text.UTF8Encoding($false, $true)  # no BOM, and bytes that are not UTF-8 throw instead of turning into U+FFFD

$script:SettingsPath = ''

# Claude Code reads this output through a pipe as UTF-8, but Windows PowerShell 5.1 writes the console code
# page there (949 on Korean Windows), garbling a non-ASCII path. Redirected streams get UTF-8; a console keeps its own.
$script:Out = [Console]::Out
$script:Err = [Console]::Error
$Utf8Out = New-Object System.Text.UTF8Encoding($false)
if ([Console]::IsOutputRedirected) { $script:Out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $Utf8Out); $script:Out.AutoFlush = $true }
if ([Console]::IsErrorRedirected) { $script:Err = New-Object System.IO.StreamWriter([Console]::OpenStandardError(), $Utf8Out); $script:Err.AutoFlush = $true }

# Every result ends with the settings file line, so the report can name the file this acted on.
function Write-Out([string]$text) {
  $script:Out.WriteLine($text)
  $script:Out.WriteLine("settings file: $script:SettingsPath")
}

function Stop-With([int]$code, [string]$text) {
  $script:Err.WriteLine($text)
  $script:Out.WriteLine("settings file: $script:SettingsPath")
  exit $code
}

function Test-Denied($record) {
  $e = $record.Exception
  while ($null -ne $e) {
    if ($e -is [System.UnauthorizedAccessException]) { return $true }
    $e = $e.InnerException
  }
  return $false
}

trap {
  if (Test-Denied $_) { Stop-With 3 "write blocked: $($_.Exception.Message); settings.json left as it was" }
  Stop-With 2 "unexpected error: $($_.Exception.Message); check settings.json"
}

function Test-Forbids($data) {
  if ($data -isnot [System.Management.Automation.PSCustomObject]) { return $false }
  $perm = $data.PSObject.Properties['permissions']
  if ($null -eq $perm -or $perm.Value -isnot [System.Management.Automation.PSCustomObject]) { return $false }
  $flag = $perm.Value.PSObject.Properties['disableBypassPermissionsMode']
  if ($null -eq $flag) { return $false }
  return (($flag.Value -is [bool]) -and $flag.Value) -or (($flag.Value -is [string]) -and ($flag.Value -ceq 'disable'))
}

# The text of UTF-8 bytes without a leading BOM; bytes that are not UTF-8 throw.
function Read-Text([byte[]]$bytes) {
  $text = $Utf8.GetString($bytes)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  return $text
}

function Read-Json([string]$text) {
  if ($text.Trim().Length -eq 0) { return [pscustomobject]@{} }
  return ($text | ConvertFrom-Json)
}

function Get-PolicyHome {
  # The override exists for this skill's tests alone.
  if ($env:BANKER_BYPASS_TEST -eq '1' -and $env:BANKER_BYPASS_POLICY_HOME) { return $env:BANKER_BYPASS_POLICY_HOME }
  if ($IsMacOS) { return '/Library/Application Support/ClaudeCode' }
  if ($IsLinux) { return '/etc/claude-code' }
  return 'C:\Program Files\ClaudeCode'
}

function Stop-Unreadable([string]$path) {
  Stop-With 1 "refused: this machine's managed policy cannot be read ($path); ask the administrator whether it allows the mode; settings.json left as it was"
}

# True when the failure only says the path is not there (as opposed to: there, but this account cannot read it).
function Test-Missing($record) {
  $e = $record.Exception
  while ($null -ne $e) {
    if ($e -is [System.IO.FileNotFoundException] -or $e -is [System.IO.DirectoryNotFoundException]) { return $true }
    $e = $e.InnerException
  }
  return $false
}

# The policy file that forbids the mode, or ''. A policy file or folder this account cannot read is refused,
# also when the folder above it cannot be searched (File.Exists and Directory.Exists say false then).
function Get-PolicyBlock {
  $policyHome = Get-PolicyHome
  $files = @([System.IO.Path]::Combine($policyHome, 'managed-settings.json'))
  $drop = [System.IO.Path]::Combine($policyHome, 'managed-settings.d')
  $listed = @()
  if (-not [System.IO.File]::Exists($drop)) {
    try { $listed = [System.IO.Directory]::GetFiles($drop) } catch { if (-not (Test-Missing $_)) { Stop-Unreadable $drop } }
  }
  $files += @($listed | Where-Object {
      $name = [System.IO.Path]::GetFileName($_)
      $name.EndsWith('.json') -and -not $name.StartsWith('.')
    } | Sort-Object)
  foreach ($file in $files) {
    if ([System.IO.Directory]::Exists($file)) { continue }
    $bytes = $null
    try { $bytes = [System.IO.File]::ReadAllBytes($file) } catch { if (-not (Test-Missing $_)) { Stop-Unreadable $file } }
    if ($null -eq $bytes) { continue }
    try { $policy = Read-Json (Read-Text $bytes) } catch { continue }
    if (Test-Forbids $policy) { return $file }
  }
  return ''
}

# @{ Data; Raw } for a JSON object; Raw is $null when there is no file. Anything else is refused.
function Read-Settings([string]$path) {
  if (-not [System.IO.File]::Exists($path)) { return @{ Data = [pscustomobject]@{}; Raw = $null } }
  $raw = [System.IO.File]::ReadAllBytes($path)
  try { $text = Read-Text $raw } catch { Stop-With 1 'refused: settings.json is not valid UTF-8; settings.json left as it was' }
  try { $data = Read-Json $text } catch { Stop-With 1 "refused: settings.json is not valid JSON ($($_.Exception.Message)); settings.json left as it was" }
  if ($data -isnot [System.Management.Automation.PSCustomObject]) { Stop-With 1 'refused: settings.json is not a JSON object; settings.json left as it was' }
  $perm = $data.PSObject.Properties['permissions']
  if ($null -ne $perm -and $perm.Value -isnot [System.Management.Automation.PSCustomObject]) {
    Stop-With 1 'refused: the permissions entry of settings.json is not an object; settings.json left as it was'
  }
  return @{ Data = $data; Raw = $raw }
}

function Test-Link([string]$path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  return ($null -ne $item) -and ($item.LinkType -in 'SymbolicLink', 'Junction')
}

# The file a chain of links at path ends at (40 hops at most), or path itself.
function Resolve-Real([string]$path) {
  for ($hop = 0; $hop -lt 40 -and (Test-Link $path); $hop++) {
    $target = @((Get-Item -LiteralPath $path -Force).Target)[0]
    if (-not [System.IO.Path]::IsPathRooted($target)) {
      $target = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($path), $target)
    }
    $path = [System.IO.Path]::GetFullPath($target)
  }
  return $path
}

# On macOS and Linux (PowerShell 7.3+), give tmp the mode of like, or 0600; Windows keeps the folder's ACL.
function Set-Mode([string]$tmp, [string]$like, [bool]$private) {
  if (-not ($IsLinux -or $IsMacOS)) { return }
  if ($null -eq [System.IO.File].GetMethod('SetUnixFileMode', [type[]]@([string], [System.IO.UnixFileMode]))) { return }
  $mode = [System.IO.UnixFileMode]'UserRead, UserWrite'
  if (-not $private -and [System.IO.File]::Exists($like)) { $mode = [System.IO.File]::GetUnixFileMode($like) }
  [System.IO.File]::SetUnixFileMode($tmp, $mode)
}

# Writes bytes to path through a temp file in the same folder. A link at path is replaced, not followed.
# [NullString]::Value: PowerShell turns $null into "" for a .NET string parameter, and Replace refuses "".
function Write-Whole([string]$path, [byte[]]$bytes, [bool]$private) {
  $full = [System.IO.Path]::GetFullPath($path)
  $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($full), '.bypass-permissions.' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [System.IO.File]::WriteAllBytes($tmp, $bytes)
    Set-Mode $tmp $full $private
    if (Test-Link $full) { [System.IO.File]::Delete($full) }
    if ([System.IO.File]::Exists($full)) { [System.IO.File]::Replace($tmp, $full, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $full) }
  } catch {
    if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) }
    throw
  }
}

function Save-Settings([string]$path, $data, $raw) {
  $bytes = $Utf8.GetBytes(($data | ConvertTo-Json -Depth 64) + "`n")
  if ($null -ne $raw -and $raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) {
    $bytes = [byte[]](@([byte]0xEF, [byte]0xBB, [byte]0xBF) + $bytes)
  }
  Write-Whole (Resolve-Real $path) $bytes $false
}

# Drop the node script's record of what `on` replaced. This fallback keeps no record, so one left by an earlier
# node `on` is stale: the mode is no longer what it describes, and a later node `off` would restore it.
function Remove-Record([string]$path) { [System.IO.File]::Delete($path + '.bypass-permissions.json') }

function Get-Mode($data) {
  $perm = $data.PSObject.Properties['permissions']
  if ($null -eq $perm -or $null -eq $perm.Value.PSObject.Properties['defaultMode']) { return $null }
  return $perm.Value.defaultMode
}

function Enable-Mode([string]$path) {
  $config = [System.IO.Path]::GetDirectoryName($path)
  if (-not [System.IO.Directory]::Exists($config)) { Stop-With 1 "refused: there is no Claude Code config folder at $config; settings.json left as it was" }
  $settings = Read-Settings $path
  $blocked = Get-PolicyBlock
  if ($blocked) { Stop-With 1 "refused: managed policy forbids bypassPermissions: $blocked; settings.json left as it was" }
  if (Test-Forbids $settings.Data) { Stop-With 1 'refused: settings.json itself sets permissions.disableBypassPermissionsMode; settings.json left as it was' }
  if ((Get-Mode $settings.Data) -ceq $Mode) { Write-Out "defaultMode = $Mode (already, nothing changed)"; exit 0 }
  if ($null -ne $settings.Raw) {
    [System.IO.File]::Open($path, 'Open', 'ReadWrite').Dispose()
    Write-Whole ($path + '.bypass-permissions.bak') $settings.Raw $true
  }
  Remove-Record $path  # the mode is not on, so any record is stale
  if ($null -eq $settings.Data.PSObject.Properties['permissions']) {
    $settings.Data | Add-Member -NotePropertyName permissions -NotePropertyValue ([pscustomobject]@{})
  }
  $settings.Data.permissions | Add-Member -NotePropertyName defaultMode -NotePropertyValue $Mode -Force
  Save-Settings $path $settings.Data $settings.Raw
  Write-Out "defaultMode = $Mode"
  exit 0
}

function Disable-Mode([string]$path) {
  $settings = Read-Settings $path
  $current = Get-Mode $settings.Data
  if ($current -cne $Mode) { Write-Out "defaultMode = $current (not bypassPermissions, nothing changed)"; exit 0 }
  [System.IO.File]::Open($path, 'Open', 'ReadWrite').Dispose()  # a read-only settings file is a lock: off honours it as on does
  [void]$settings.Data.permissions.PSObject.Properties.Remove('defaultMode')
  Save-Settings $path $settings.Data $settings.Raw
  Remove-Record $path  # only after the write: if it failed, the record is still the way back
  Write-Out "defaultMode removed (Claude Code's default start mode)"
  exit 0
}

$userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { [System.IO.Path]::Combine($userHome, '.claude') }
$settingsPath = [System.IO.Path]::Combine($configDir, 'settings.json')
$script:SettingsPath = $settingsPath
$request = $args -join ' '
if ($request -ceq 'on --yes') { Enable-Mode $settingsPath }
if ($request -ceq 'off') { Disable-Mode $settingsPath }
Stop-With 1 "refused: usage is 'bypass-permissions.ps1 on --yes' or 'bypass-permissions.ps1 off'"
