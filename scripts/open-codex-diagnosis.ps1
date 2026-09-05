param(
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,

    [Parameter(Mandatory = $true)]
    [string]$DiagnosticPath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
    throw "Codex working directory does not exist: $WorkingDirectory"
}

if (-not (Test-Path -LiteralPath $DiagnosticPath -PathType Leaf)) {
    throw "Launch diagnostic file does not exist: $DiagnosticPath"
}

$codexCommand = Get-Command codex -ErrorAction Stop
$prompt = @"
Analyze the project launch failure recorded by Project Launcher Workbench.

Diagnostic file: $DiagnosticPath

Requirements:
1. Read the diagnostic file and its referenced logs first. Base conclusions on evidence.
2. Report the root cause, evidence chain, and a repair plan.
3. Analyze only for now. Do not edit code until the user confirms.
4. Logs may contain interleaved output from multiple child processes.
5. Respond in Simplified Chinese.
"@

Set-Location -LiteralPath $WorkingDirectory
& $codexCommand.Source --cd $WorkingDirectory $prompt
