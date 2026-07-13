[CmdletBinding()]
param(
  [string]$Destination = [Environment]::GetFolderPath("Desktop")
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherPath = Join-Path $projectRoot "launch-workbench.ps1"
$iconPath = Join-Path $projectRoot "logo.ico"
$powershellPath = Join-Path $PSHOME "powershell.exe"
$shortcutPath = Join-Path $Destination "Project Launcher Workbench.lnk"

if (-not (Test-Path -LiteralPath $Destination)) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershellPath
$shortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File `"$launcherPath`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = "Open Project Launcher Workbench with Windows tray control"
$shortcut.Save()

Write-Output $shortcutPath
