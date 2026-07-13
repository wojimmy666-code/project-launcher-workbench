[CmdletBinding()]
param()

& (Join-Path $PSScriptRoot "tray-workbench.ps1")
exit $LASTEXITCODE
