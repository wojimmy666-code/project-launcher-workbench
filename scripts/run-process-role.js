const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ALLOWED_ROLES = new Set(["intermediate", "service", "interactive"]);

function parseArguments(argv) {
  const values = [...argv];
  const role = String(values.shift() || "").toLowerCase();
  if (!ALLOWED_ROLES.has(role)) {
    throw new Error("Role must be intermediate, service, or interactive");
  }

  let cwd = process.cwd();
  if (values[0] === "--cwd") {
    values.shift();
    cwd = path.resolve(String(values.shift() || ""));
  }
  if (values.shift() !== "--") {
    throw new Error("Expected -- before the executable");
  }

  const executable = String(values.shift() || "");
  if (!executable) throw new Error("Executable is required");
  return { role, cwd, executable, args: values.map(String) };
}

function quoteWindowsArgument(value) {
  const text = String(value);
  if (text && !/[\s"]/u.test(text)) return text;
  let result = '"';
  let backslashes = 0;
  for (const character of text) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}

function createCommandLine(executable, args) {
  return [executable, ...args].map(quoteWindowsArgument).join(" ");
}

function resolveOutputPaths(environment, role) {
  const logDir = String(environment.PROJECT_LAUNCHER_LOG_DIR || "").trim()
    || path.join(process.cwd(), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  return {
    stdoutPath: path.join(logDir, `${role}-stdout.log`),
    stderrPath: path.join(logDir, `${role}-stderr.log`)
  };
}

function resolveEffectiveRole(role, environment) {
  if (role === "service" && environment.PROJECT_LAUNCHER_SHOW_SERVICE_CONSOLES !== "1") {
    return "intermediate";
  }
  if (role === "interactive" && environment.PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE !== "1") {
    throw new Error("Interactive console permission was not granted");
  }
  return role;
}

function createPlan(input, environment = process.env) {
  const outputs = resolveOutputPaths(environment, input.role);
  return {
    version: 1,
    executable: input.executable,
    commandLine: createCommandLine(input.executable, input.args),
    cwd: input.cwd,
    ...outputs,
    windowRole: resolveEffectiveRole(input.role, environment)
  };
}

function run(argv = process.argv.slice(2), environment = process.env) {
  if (process.platform !== "win32") {
    throw new Error("Process role runner is only supported on Windows");
  }
  if (environment.PROJECT_LAUNCHER_MANAGED !== "1") {
    throw new Error("Process role runner requires PROJECT_LAUNCHER_MANAGED=1");
  }

  const input = parseArguments(argv);
  const plan = createPlan(input, environment);
  const hostPath = String(environment.PROJECT_LAUNCHER_PROCESS_HOST || "").trim();
  if (!hostPath || !fs.existsSync(hostPath)) {
    throw new Error("PROJECT_LAUNCHER_PROCESS_HOST does not point to a readable host script");
  }

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      hostPath,
      "-PlanBase64",
      Buffer.from(JSON.stringify(plan), "utf8").toString("base64")
    ], {
      cwd: input.cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Role process host exited from signal ${signal}`));
        return;
      }
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

if (require.main === module) {
  run()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      console.error(`[process-role] ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  createCommandLine,
  createPlan,
  parseArguments,
  resolveEffectiveRole,
  run
};
