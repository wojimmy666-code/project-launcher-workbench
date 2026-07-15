[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeRoot = Join-Path $env:LOCALAPPDATA "ProjectLauncherWorkbench"
$stdoutLog = Join-Path $runtimeRoot "server.log"
$stderrLog = Join-Path $runtimeRoot "server-error.log"
$launcherLog = Join-Path $runtimeRoot "launcher.log"
$serverPidFile = Join-Path $runtimeRoot "server.pid"
$iconPath = Join-Path $projectRoot "logo.ico"
$serverPath = Join-Path $projectRoot "server\index.js"
$mutexName = "Local\ProjectLauncherWorkbench.Tray"
$windowMutexName = "Local\ProjectLauncherWorkbench.Window"
$workbenchWindowTitle = "本地项目执行管理台"
$script:managedServerPid = $null
$script:exitRequested = $false

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Workbench
{
    public static class AppWindow
    {
        private const int SW_SHOW = 5;
        private const int SW_RESTORE = 9;
        private const uint WM_GETICON = 0x007F;
        private const uint WM_SETICON = 0x0080;
        private const int ICON_SMALL = 0;
        private const int ICON_BIG = 1;
        private const uint IMAGE_ICON = 1;
        private const uint LR_LOADFROMFILE = 0x0010;
        private const int SM_CXICON = 11;
        private const int SM_CYICON = 12;
        private const int SM_CXSMICON = 49;
        private const int SM_CYSMICON = 50;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_SHOWWINDOW = 0x0040;

        private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        private static IntPtr largeIcon = IntPtr.Zero;
        private static IntPtr smallIcon = IntPtr.Zero;
        private static string loadedIconPath;

        public static string LastActivationError { get; private set; }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindow(string className, string windowName);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int command);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadImage(
            IntPtr instance,
            string name,
            uint type,
            int desiredWidth,
            int desiredHeight,
            uint loadFlags
        );

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(
            IntPtr hWnd,
            IntPtr insertAfter,
            int x,
            int y,
            int width,
            int height,
            uint flags
        );

        private static bool ApplyIcon(IntPtr handle, string iconPath)
        {
            if (String.IsNullOrWhiteSpace(iconPath))
            {
                return false;
            }

            if (
                !String.Equals(loadedIconPath, iconPath, StringComparison.OrdinalIgnoreCase) ||
                largeIcon == IntPtr.Zero ||
                smallIcon == IntPtr.Zero
            )
            {
                var nextLargeIcon = LoadImage(
                    IntPtr.Zero,
                    iconPath,
                    IMAGE_ICON,
                    GetSystemMetrics(SM_CXICON),
                    GetSystemMetrics(SM_CYICON),
                    LR_LOADFROMFILE
                );
                var nextSmallIcon = LoadImage(
                    IntPtr.Zero,
                    iconPath,
                    IMAGE_ICON,
                    GetSystemMetrics(SM_CXSMICON),
                    GetSystemMetrics(SM_CYSMICON),
                    LR_LOADFROMFILE
                );

                if (nextLargeIcon == IntPtr.Zero || nextSmallIcon == IntPtr.Zero)
                {
                    return false;
                }

                largeIcon = nextLargeIcon;
                smallIcon = nextSmallIcon;
                loadedIconPath = iconPath;
            }

            if (SendMessage(handle, WM_GETICON, new IntPtr(ICON_BIG), IntPtr.Zero) != largeIcon)
            {
                SendMessage(handle, WM_SETICON, new IntPtr(ICON_BIG), largeIcon);
            }

            if (SendMessage(handle, WM_GETICON, new IntPtr(ICON_SMALL), IntPtr.Zero) != smallIcon)
            {
                SendMessage(handle, WM_SETICON, new IntPtr(ICON_SMALL), smallIcon);
            }

            return true;
        }

        public static bool SetIcon(string title, string iconPath)
        {
            var handle = FindWindow(null, title);
            return handle != IntPtr.Zero && ApplyIcon(handle, iconPath);
        }

        public static bool Activate(string title, string iconPath)
        {
            LastActivationError = null;
            var handle = FindWindow(null, title);
            if (handle == IntPtr.Zero)
            {
                return false;
            }

            var errors = new System.Collections.Generic.List<string>();
            ApplyIcon(handle, iconPath);
            ShowWindow(handle, IsIconic(handle) ? SW_RESTORE : SW_SHOW);
            if (!BringWindowToTop(handle))
            {
                errors.Add("BringWindowToTop failed");
            }
            if (!SetForegroundWindow(handle))
            {
                errors.Add("SetForegroundWindow was rejected");
            }
            var flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW;
            if (!SetWindowPos(handle, HWND_NOTOPMOST, 0, 0, 0, 0, flags))
            {
                errors.Add("SetWindowPos(HWND_NOTOPMOST) failed with error " + Marshal.GetLastWin32Error());
            }
            LastActivationError = String.Join("; ", errors);
            return true;
        }
    }
}
'@

function Write-LauncherLog {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $launcherLog -Value "[$timestamp] $Message" -Encoding UTF8
}

function Show-LaunchError {
  param([string]$Message)
  Write-LauncherLog $Message
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    "Project Launcher Workbench",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

function Show-TrayMessage {
  param(
    [string]$Message,
    [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info
  )

  if ($script:notifyIcon) {
    $script:notifyIcon.ShowBalloonTip(1800, "Project Launcher Workbench", $Message, $Icon)
  }
}

function Get-WorkbenchAddress {
  $hostName = "127.0.0.1"
  $port = 3344
  $configPath = Join-Path $projectRoot "config\projects.json"

  if (Test-Path -LiteralPath $configPath) {
    try {
      $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($config.server.port) {
        $port = [int]$config.server.port
      }
      if ($config.server.host -and $config.server.host -notin @("0.0.0.0", "::")) {
        $hostName = [string]$config.server.host
      }
    } catch {
      Write-LauncherLog "Unable to read server settings; using 127.0.0.1:3344. $($_.Exception.Message)"
    }
  }

  return "http://${hostName}:${port}"
}

function Test-WorkbenchReady {
  param([string]$Address)

  try {
    $request = [System.Net.HttpWebRequest]::Create($Address)
    $request.Timeout = 900
    $request.ReadWriteTimeout = 900
    $request.Proxy = $null
    $response = $request.GetResponse()
    $ready = [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500
    $response.Close()
    return $ready
  } catch {
    return $false
  }
}

function Find-ChromeExecutable {
  $candidates = [System.Collections.Generic.List[string]]::new()
  $command = Get-Command chrome.exe -ErrorAction SilentlyContinue
  if ($command) {
    $candidates.Add($command.Source)
  }

  foreach ($registryPath in @(
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
  )) {
    $registryValue = Get-ItemProperty -Path $registryPath -ErrorAction SilentlyContinue
    if ($registryValue.'(default)') {
      $candidates.Add($registryValue.'(default)')
    }
  }

  foreach ($path in @(
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe")
  )) {
    if ($path) {
      $candidates.Add($path)
    }
  }

  return $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    Select-Object -First 1
}

function Get-ManagedServerProcess {
  if (-not (Test-Path -LiteralPath $serverPidFile)) {
    return $null
  }

  try {
    $serverPid = [int](Get-Content -LiteralPath $serverPidFile -Raw -Encoding ASCII).Trim()
    $process = Get-Process -Id $serverPid -ErrorAction Stop
    if ($process.ProcessName -ne "node") {
      throw "Recorded process is not Node.js."
    }
    $script:managedServerPid = $serverPid
    return $process
  } catch {
    Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
    $script:managedServerPid = $null
    return $null
  }
}

function Start-WorkbenchService {
  if (Test-WorkbenchReady -Address $script:address) {
    Get-ManagedServerProcess | Out-Null
    return
  }

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    throw "Node.js was not found. Install Node.js 20 or later, then try again."
  }

  Write-LauncherLog "Starting managed local service at $script:address"
  $process = Start-Process -FilePath $nodeCommand.Source `
    -ArgumentList @("`"$serverPath`"") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

  $script:managedServerPid = $process.Id
  Set-Content -LiteralPath $serverPidFile -Value $process.Id -Encoding ASCII

  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    if (Test-WorkbenchReady -Address $script:address) {
      return
    }
  }

  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
  $script:managedServerPid = $null
  throw "The local service did not start. Check $stderrLog for details."
}

function Stop-WorkbenchService {
  $process = Get-ManagedServerProcess
  if (-not $process) {
    return $false
  }

  Write-LauncherLog "Stopping managed local service PID $($process.Id)"
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
  $script:managedServerPid = $null
  return $true
}

function Open-WorkbenchWindow {
  param([switch]$SkipWindowIcon)

  $windowIconPath = if ($SkipWindowIcon) { $null } else { $iconPath }
  $windowMutex = New-Object System.Threading.Mutex($false, $windowMutexName)
  $windowLockHeld = $false

  try {
    try {
      $windowLockHeld = $windowMutex.WaitOne(10000)
    } catch [System.Threading.AbandonedMutexException] {
      $windowLockHeld = $true
    }

    if (-not $windowLockHeld) {
      throw "Timed out waiting for the workbench window lock."
    }

    Start-WorkbenchService
    if (-not $script:chromePath) {
      throw "Google Chrome was not found. Install Chrome, then try again."
    }

    if ([Workbench.AppWindow]::Activate($workbenchWindowTitle, $windowIconPath)) {
      if ([Workbench.AppWindow]::LastActivationError) {
        Write-LauncherLog "Window activation warning: $([Workbench.AppWindow]::LastActivationError)"
      }
      Write-LauncherLog "Activated existing Chrome app window at $script:address"
      Update-TrayStatus
      return
    }

    Write-LauncherLog "Opening Chrome app window at $script:address"
    Start-Process -FilePath $script:chromePath -ArgumentList @("--app=$script:address", "--no-first-run", "--disable-default-apps", "--window-size=1440,900") -WorkingDirectory $projectRoot | Out-Null

    $windowFound = $false
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
      Start-Sleep -Milliseconds 100
      if ([Workbench.AppWindow]::Activate($workbenchWindowTitle, $windowIconPath)) {
        if ([Workbench.AppWindow]::LastActivationError) {
          Write-LauncherLog "Window activation warning: $([Workbench.AppWindow]::LastActivationError)"
        }
        $windowFound = $true
        break
      }
    }

    if (-not $windowFound) {
      Write-LauncherLog "Chrome was started, but the app window was not detected within 8 seconds."
    }
    Update-TrayStatus
  } finally {
    if ($windowLockHeld) {
      try { $windowMutex.ReleaseMutex() } catch {}
    }
    $windowMutex.Dispose()
  }
}

function Update-TrayStatus {
  if (-not $script:statusItem) {
    return
  }

  if (Test-WorkbenchReady -Address $script:address) {
    $managed = Get-ManagedServerProcess
    $script:statusItem.Text = if ($managed) { "本地服务：运行中（托盘管理）" } else { "本地服务：运行中" }
    $script:notifyIcon.Text = "项目管理台 - 本地服务正常"
  } else {
    $script:statusItem.Text = "本地服务：未运行"
    $script:notifyIcon.Text = "项目管理台 - 本地服务未运行"
  }
}

function Restart-WorkbenchService {
  $ready = Test-WorkbenchReady -Address $script:address
  $managed = Get-ManagedServerProcess

  if ($ready -and -not $managed) {
    [System.Windows.Forms.MessageBox]::Show(
      "当前本地服务不是由托盘启动，未执行重启。关闭原服务后可由托盘接管。",
      "Project Launcher Workbench",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
    return
  }

  Stop-WorkbenchService | Out-Null
  Start-WorkbenchService
  Update-TrayStatus
  Show-TrayMessage "本地服务已重新启动。"
}

function Open-LogDirectory {
  Start-Process -FilePath "explorer.exe" -ArgumentList @("`"$runtimeRoot`"") | Out-Null
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
$script:address = Get-WorkbenchAddress
$script:chromePath = Find-ChromeExecutable

if (-not $createdNew) {
  try {
    Open-WorkbenchWindow -SkipWindowIcon
  } catch {
    Show-LaunchError $_.Exception.Message
  } finally {
    $mutex.Dispose()
  }
  exit
}

try {
  Start-WorkbenchService
  if (-not $script:chromePath) {
    throw "Google Chrome was not found. Install Chrome, then try again."
  }

  $trayIcon = New-Object System.Drawing.Icon($iconPath)
  $script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
  $script:notifyIcon.Icon = $trayIcon
  $script:notifyIcon.Text = "项目管理台"

  $contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = $contextMenu.Items.Add("打开工作台")
  $openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
  [void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $script:statusItem = $contextMenu.Items.Add("本地服务：检查中")
  $script:statusItem.Enabled = $false
  $checkItem = $contextMenu.Items.Add("重新检查状态")
  $restartItem = $contextMenu.Items.Add("重启本地服务")
  $logsItem = $contextMenu.Items.Add("打开日志目录")
  [void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $exitItem = $contextMenu.Items.Add("退出工作台")

  $script:notifyIcon.ContextMenuStrip = $contextMenu
  $script:notifyIcon.Visible = $true

  $openAction = {
    try {
      Open-WorkbenchWindow
    } catch {
      Show-TrayMessage $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error)
      Write-LauncherLog $_.Exception.Message
    }
  }
  $openItem.add_Click($openAction)
  $script:notifyIcon.add_DoubleClick($openAction)

  $checkItem.add_Click({
    Update-TrayStatus
    $message = if (Test-WorkbenchReady -Address $script:address) { "本地服务运行正常。" } else { "本地服务当前未运行。" }
    Show-TrayMessage $message
  })

  $restartItem.add_Click({
    try {
      Restart-WorkbenchService
    } catch {
      Show-TrayMessage $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error)
      Write-LauncherLog $_.Exception.Message
    }
  })

  $logsItem.add_Click({ Open-LogDirectory })
  $exitItem.add_Click({
    $script:exitRequested = $true
    [System.Windows.Forms.Application]::Exit()
  })

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 5000
  $timer.add_Tick({ Update-TrayStatus })
  $timer.Start()

  $windowIconTimer = New-Object System.Windows.Forms.Timer
  $windowIconTimer.Interval = 1000
  $windowIconTimer.add_Tick({
    [void][Workbench.AppWindow]::SetIcon($workbenchWindowTitle, $iconPath)
  })
  $windowIconTimer.Start()

  Update-TrayStatus
  Open-WorkbenchWindow
  Show-TrayMessage "工作台已在后台运行。关闭 Chrome 窗口后，可双击托盘图标重新打开。"
  Write-LauncherLog "Tray controller started"
  [System.Windows.Forms.Application]::Run()
} catch {
  Show-LaunchError $_.Exception.Message
} finally {
  if ($windowIconTimer) {
    $windowIconTimer.Stop()
    $windowIconTimer.Dispose()
  }
  if ($timer) {
    $timer.Stop()
    $timer.Dispose()
  }
  if ($script:notifyIcon) {
    $script:notifyIcon.Visible = $false
    $script:notifyIcon.Dispose()
  }
  if ($trayIcon) {
    $trayIcon.Dispose()
  }
  if ($script:exitRequested) {
    Stop-WorkbenchService | Out-Null
  }
  Write-LauncherLog "Tray controller stopped"
  try {
    $mutex.ReleaseMutex()
  } catch {}
  $mutex.Dispose()
}
