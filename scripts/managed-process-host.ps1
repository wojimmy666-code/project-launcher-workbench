param(
  [Parameter(Mandatory = $true)]
  [string]$PlanBase64
)

$ErrorActionPreference = "Stop"

try {
  $planJson = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String($PlanBase64)
  )
  $plan = $planJson | ConvertFrom-Json

  if ($plan.version -ne 1) {
    throw "Unsupported managed process plan version: $($plan.version)"
  }
  if (-not $plan.executable -or -not $plan.commandLine -or -not $plan.cwd) {
    throw "Managed process plan is missing executable, commandLine, or cwd"
  }

  $windowRole = [string]$plan.windowRole
  $showWindow = $false
  switch ($windowRole) {
    "intermediate" { $showWindow = $false }
    "service" { $showWindow = $env:PROJECT_LAUNCHER_SHOW_SERVICE_CONSOLES -eq "1" }
    "interactive" {
      if ($env:PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE -ne "1") {
        throw "Interactive console permission was not granted"
      }
      $showWindow = $true
    }
    default { throw "Unsupported managed process window role: $windowRole" }
  }

  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ProjectLauncherManagedProcess
{
    private const uint FILE_APPEND_DATA = 0x00000004;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint OPEN_ALWAYS = 4;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const short SW_HIDE = 0;
    private const short SW_SHOW = 5;
    private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    private const uint CREATE_NEW_CONSOLE = 0x00000010;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_FAILED = 0xFFFFFFFF;

    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SECURITY_ATTRIBUTES securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(
        IntPtr file,
        byte[] buffer,
        uint bytesToWrite,
        out uint bytesWritten,
        IntPtr overlapped
    );

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static IntPtr OpenInheritedFile(
        string fileName,
        uint desiredAccess,
        uint creationDisposition,
        ref SECURITY_ATTRIBUTES securityAttributes
    )
    {
        IntPtr handle = CreateFileW(
            fileName,
            desiredAccess,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ref securityAttributes,
            creationDisposition,
            FILE_ATTRIBUTE_NORMAL,
            IntPtr.Zero
        );
        if (handle == InvalidHandleValue)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open process output: " + fileName);
        }
        return handle;
    }

    private static void WriteHostLog(IntPtr handle, string message)
    {
        if (handle == InvalidHandleValue || handle == IntPtr.Zero) return;
        byte[] bytes = new UTF8Encoding(false).GetBytes(
            "[managed-process-host] " + message + Environment.NewLine
        );
        uint bytesWritten;
        WriteFile(handle, bytes, (uint)bytes.Length, out bytesWritten, IntPtr.Zero);
    }

    public static int Run(
        string executable,
        string commandLine,
        string currentDirectory,
        string stdoutPath,
        string stderrPath,
        bool showWindow
    )
    {
        SECURITY_ATTRIBUTES securityAttributes = new SECURITY_ATTRIBUTES();
        securityAttributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        securityAttributes.bInheritHandle = true;

        IntPtr stdinHandle = InvalidHandleValue;
        IntPtr stdoutHandle = InvalidHandleValue;
        IntPtr stderrHandle = InvalidHandleValue;
        PROCESS_INFORMATION processInformation = new PROCESS_INFORMATION();

        try
        {
            STARTUPINFO startupInfo = new STARTUPINFO();
            startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startupInfo.dwFlags = STARTF_USESHOWWINDOW;
            startupInfo.wShowWindow = showWindow ? SW_SHOW : SW_HIDE;
            stderrHandle = OpenInheritedFile(stderrPath, FILE_APPEND_DATA, OPEN_ALWAYS, ref securityAttributes);
            if (!showWindow)
            {
                stdinHandle = OpenInheritedFile("NUL", GENERIC_READ | GENERIC_WRITE, OPEN_EXISTING, ref securityAttributes);
                stdoutHandle = OpenInheritedFile(stdoutPath, FILE_APPEND_DATA, OPEN_ALWAYS, ref securityAttributes);
                startupInfo.dwFlags |= STARTF_USESTDHANDLES;
                startupInfo.hStdInput = stdinHandle;
                startupInfo.hStdOutput = stdoutHandle;
                startupInfo.hStdError = stderrHandle;
            }

            uint creationFlags = CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT;
            bool created = CreateProcessW(
                executable,
                new StringBuilder(commandLine),
                IntPtr.Zero,
                IntPtr.Zero,
                !showWindow,
                creationFlags,
                IntPtr.Zero,
                currentDirectory,
                ref startupInfo,
                out processInformation
            );
            if (!created)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot create managed project process");
            }

            WriteHostLog(
                stderrHandle,
                "started pid=" + processInformation.dwProcessId + " executable=" + executable
            );

            uint waitResult = WaitForSingleObject(processInformation.hProcess, INFINITE);
            if (waitResult == WAIT_FAILED)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot wait for managed project process");
            }
            if (waitResult != WAIT_OBJECT_0)
            {
                throw new InvalidOperationException("Unexpected managed project wait result: " + waitResult);
            }

            uint exitCode;
            if (!GetExitCodeProcess(processInformation.hProcess, out exitCode))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read managed project exit code");
            }
            WriteHostLog(
                stderrHandle,
                "exited pid=" + processInformation.dwProcessId + " code=" + exitCode
            );
            return unchecked((int)exitCode);
        }
        finally
        {
            if (processInformation.hThread != IntPtr.Zero) CloseHandle(processInformation.hThread);
            if (processInformation.hProcess != IntPtr.Zero) CloseHandle(processInformation.hProcess);
            if (stderrHandle != InvalidHandleValue) CloseHandle(stderrHandle);
            if (stdoutHandle != InvalidHandleValue) CloseHandle(stdoutHandle);
            if (stdinHandle != InvalidHandleValue) CloseHandle(stdinHandle);
        }
    }
}
'@

  $exitCode = [ProjectLauncherManagedProcess]::Run(
    [string]$plan.executable,
    [string]$plan.commandLine,
    [string]$plan.cwd,
    [string]$plan.stdoutPath,
    [string]$plan.stderrPath,
    [bool]$showWindow
  )
  exit $exitCode
} catch {
  $message = "[managed-process-host] $($_.Exception.Message)"
  try {
    if ($plan -and $plan.stderrPath) {
      Add-Content -LiteralPath ([string]$plan.stderrPath) -Value $message -Encoding UTF8
    }
  } catch {
    # The host has no visible console by design; preserve the original failure code.
  }
  exit 255
}
