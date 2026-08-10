[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CommandLineBase64,

  [Parameter(Mandatory = $true)]
  [string]$WorkingDirectory
)

$ErrorActionPreference = "Stop"

try {
  $commandLineBytes = [Convert]::FromBase64String($CommandLineBase64)
  $commandLine = [Text.Encoding]::Unicode.GetString($commandLineBytes)
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    throw "The interactive BAT command line is empty."
  }
  if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
    throw "The interactive BAT working directory does not exist: $WorkingDirectory"
  }

  # Start-Process gives the inner cmd.exe a real console with usable stdin and
  # stdout. This hidden wrapper waits for that console and returns its real
  # exit code, so the workbench can track the project without keeping cmd /k.
  $cmdArguments = '/d /s /c "' + $commandLine + '"'
  $process = Start-Process `
    -FilePath $env:ComSpec `
    -ArgumentList $cmdArguments `
    -WorkingDirectory $WorkingDirectory `
    -PassThru `
    -Wait

  exit [int]$process.ExitCode
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
