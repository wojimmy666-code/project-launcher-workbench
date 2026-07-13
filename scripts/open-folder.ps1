[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$item = Get-Item -LiteralPath $Path -Force
if (-not $item.PSIsContainer) {
  throw "Folder path is not a directory: $Path"
}

$targetPath = $item.FullName

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Workbench
{
    public static class WindowActivator
    {
        private const int SW_SHOW = 5;
        private const int SW_RESTORE = 9;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_SHOWWINDOW = 0x0040;

        private static readonly IntPtr HWND_TOP = IntPtr.Zero;
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindowAsync(IntPtr hWnd, int command);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint attachThread, uint attachToThread, bool attach);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr SetFocus(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(
            IntPtr hWnd,
            IntPtr insertAfter,
            int x,
            int y,
            int width,
            int height,
            uint flags
        );

        public static bool Activate(long rawHandle)
        {
            var handle = new IntPtr(rawHandle);
            if (handle == IntPtr.Zero || !IsWindow(handle))
            {
                return false;
            }

            ShowWindowAsync(handle, IsIconic(handle) ? SW_RESTORE : SW_SHOW);

            var currentThread = GetCurrentThreadId();
            var foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
            var targetThread = GetWindowThreadProcessId(handle, IntPtr.Zero);
            var attachedForeground = false;
            var attachedTarget = false;

            try
            {
                if (foregroundThread != 0 && foregroundThread != currentThread)
                {
                    attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
                }

                if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread)
                {
                    attachedTarget = AttachThreadInput(currentThread, targetThread, true);
                }

                var flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW;
                var positioned = SetWindowPos(handle, HWND_TOP, 0, 0, 0, 0, flags);
                BringWindowToTop(handle);
                SetFocus(handle);
                var activated = SetForegroundWindow(handle);

                if (!activated)
                {
                    var raised = SetWindowPos(handle, HWND_TOPMOST, 0, 0, 0, 0, flags);
                    raised = SetWindowPos(handle, HWND_NOTOPMOST, 0, 0, 0, 0, flags) || raised;
                    BringWindowToTop(handle);
                    activated = SetForegroundWindow(handle) || raised;
                }

                return activated || positioned;
            }
            finally
            {
                if (attachedTarget)
                {
                    AttachThreadInput(currentThread, targetThread, false);
                }

                if (attachedForeground)
                {
                    AttachThreadInput(currentThread, foregroundThread, false);
                }
            }
        }
    }
}
'@

function Get-NormalizedPath {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  try {
    $fullPath = [System.IO.Path]::GetFullPath($Value)
    $rootPath = [System.IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -gt $rootPath.Length) {
      return $fullPath.TrimEnd([char[]]@('\', '/'))
    }
    return $fullPath
  } catch {
    return $null
  }
}

function Find-ExplorerWindow {
  param(
    $ShellApplication,
    [string]$NormalizedTarget
  )

  foreach ($window in @($ShellApplication.Windows())) {
    try {
      $executableName = [System.IO.Path]::GetFileName([string]$window.FullName)
      if (-not $executableName.Equals("explorer.exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
      }

      $windowPath = Get-NormalizedPath ([string]$window.Document.Folder.Self.Path)
      if ($windowPath -and $windowPath.Equals($NormalizedTarget, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $window
      }
    } catch {
      continue
    }
  }

  return $null
}

$normalizedTarget = Get-NormalizedPath $targetPath
$shellApplication = New-Object -ComObject Shell.Application
$existingWindow = Find-ExplorerWindow $shellApplication $normalizedTarget

if ($null -ne $existingWindow) {
  if ([Workbench.WindowActivator]::Activate([long]$existingWindow.HWND)) {
    Write-Output "activated"
    exit 0
  }
}

$explorerArgument = '/n,"{0}"' -f $targetPath.Replace('"', '""')
Start-Process -FilePath "explorer.exe" -ArgumentList $explorerArgument | Out-Null

$deadline = [DateTime]::UtcNow.AddSeconds(2)
do {
  Start-Sleep -Milliseconds 100
  $openedWindow = Find-ExplorerWindow $shellApplication $normalizedTarget
  if ($null -ne $openedWindow) {
    [void][Workbench.WindowActivator]::Activate([long]$openedWindow.HWND)
    break
  }
} while ([DateTime]::UtcNow -lt $deadline)

Write-Output "opened"
