[CmdletBinding()]
param([int]$TimeoutMs = 10000)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Get-CodexMainProcess {
  $processes = @(
    Get-CimInstance Win32_Process -Filter 'Name=''ChatGPT.exe''' -ErrorAction SilentlyContinue
  )

  return $processes |
    Where-Object {
      $commandLine = [string]$_.CommandLine
      $executablePath = [string]$_.ExecutablePath
      $isMainProcess = $commandLine -notmatch '(?:^|\s)--type='
      $isCodexPackage = -not $executablePath -or $executablePath -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$'
      $isMainProcess -and $isCodexPackage
    } |
    Sort-Object CreationDate |
    Select-Object -First 1
}

function Resolve-CodexAppId {
  $bang = [char]33
  $startApp = Get-StartApps -ErrorAction SilentlyContinue |
    Where-Object { $_.AppID -like ('OpenAI.Codex_*' + $bang + 'App') } |
    Select-Object -First 1
  if ($startApp) {
    return [string]$startApp.AppID
  }

  $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($package) {
    return ([string]$package.PackageFamilyName + $bang + 'App')
  }

  throw 'CODEX_APP_NOT_INSTALLED'
}

$existing = Get-CodexMainProcess
$appId = Resolve-CodexAppId
$appTarget = 'shell:AppsFolder\' + $appId

# This starts a missing instance and delegates to the existing single instance.
Start-Process -FilePath 'explorer.exe' -ArgumentList @($appTarget) | Out-Null

$deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(1000, $TimeoutMs))
$mainProcess = $existing
while (-not $mainProcess -and [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $mainProcess = Get-CodexMainProcess
}

if (-not $mainProcess) {
  throw 'CODEX_APP_LAUNCH_TIMEOUT'
}

[pscustomobject]@{
  ok = $true
  action = if ($existing) { 'activated' } else { 'started' }
  pid = [int]$mainProcess.ProcessId
  appId = $appId
} | ConvertTo-Json -Compress
