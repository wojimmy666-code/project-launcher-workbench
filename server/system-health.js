const { execFile } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 3500;
const NETWORK_TARGET = "https://www.baidu.com";
const EXTERNAL_TARGET = "https://www.google.com/generate_204";

async function checkSystemHealth(serverConfig = {}) {
  const checkedAt = new Date().toISOString();
  const [network, external] = await Promise.all([
    checkHttpTarget({
      key: "network",
      target: NETWORK_TARGET,
      okLabel: "\u8fde\u901a",
      failureState: "down",
      failureLabel: "\u4e0d\u53ef\u8fbe"
    }),
    checkHttpTarget({
      key: "external",
      target: EXTERNAL_TARGET,
      okLabel: "\u8fde\u901a",
      failureState: "degraded",
      failureLabel: "\u53d7\u9650",
      proxyFallback: true
    })
  ]);

  return {
    server: {
      state: "ok",
      label: "\u8fd0\u884c\u4e2d",
      host: serverConfig.host || "127.0.0.1",
      port: Number(serverConfig.port || 3344),
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      checkedAt
    },
    network,
    external,
    checkedAt
  };
}

async function checkHttpTarget(options) {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(options.target, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });
    await response.body?.cancel?.();

    const latencyMs = Date.now() - startedAt;
    if (response.status >= 200 && response.status < 400) {
      return {
        state: "ok",
        label: options.okLabel,
        target: options.target,
        statusCode: response.status,
        latencyMs,
        checkedAt
      };
    }

    return {
      state: "degraded",
      label: "\u53d7\u9650",
      target: options.target,
      statusCode: response.status,
      latencyMs,
      message: `HTTP ${response.status}`,
      checkedAt
    };
  } catch (error) {
    const fallback = options.proxyFallback
      ? await checkWithWindowsSystemProxy(options, startedAt, timeoutMs)
      : null;

    if (fallback?.ok) {
      return {
        state: "ok",
        label: options.okLabel,
        target: options.target,
        statusCode: fallback.statusCode,
        latencyMs: Date.now() - startedAt,
        message: "\u901a\u8fc7\u7cfb\u7edf\u4ee3\u7406",
        via: "system-proxy",
        checkedAt
      };
    }

    const directMessage = normalizeNetworkError(error);
    const fallbackMessage = fallback?.message ? `\uff1b\u7cfb\u7edf\u4ee3\u7406\u68c0\u6d4b\u5931\u8d25\uff1a${fallback.message}` : "";
    return {
      state: options.failureState,
      label: options.failureLabel,
      target: options.target,
      latencyMs: Date.now() - startedAt,
      message: `${directMessage}${fallbackMessage}`,
      checkedAt
    };
  }
}

function checkWithWindowsSystemProxy(options, startedAt, timeoutMs) {
  if (process.platform !== "win32") return Promise.resolve(null);

  const remainingMs = Math.max(1200, timeoutMs + 1200);
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
    "$url = $env:PROJECT_LAUNCHER_HEALTH_TARGET",
    "$timeout = [Math]::Max(1, [int]$env:PROJECT_LAUNCHER_HEALTH_TIMEOUT_SECONDS)",
    "try {",
    "  $response = Invoke-WebRequest -Uri $url -Method GET -MaximumRedirection 5 -TimeoutSec $timeout -UseBasicParsing",
    "  [pscustomobject]@{ ok = $true; statusCode = [int]$response.StatusCode; message = '' } | ConvertTo-Json -Compress",
    "} catch {",
    "  $statusCode = $null",
    "  if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $statusCode = [int]$_.Exception.Response.StatusCode }",
    "  [pscustomobject]@{ ok = $false; statusCode = $statusCode; message = $_.Exception.Message } | ConvertTo-Json -Compress",
    "}"
  ].join("; ");

  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      timeout: remainingMs,
      windowsHide: true,
      env: {
        ...process.env,
        PROJECT_LAUNCHER_HEALTH_TARGET: options.target,
        PROJECT_LAUNCHER_HEALTH_TIMEOUT_SECONDS: String(timeoutSeconds)
      }
    }, (error, stdout) => {
      if (Date.now() - startedAt > timeoutMs + remainingMs + 500) {
        resolve({ ok: false, message: "\u7cfb\u7edf\u4ee3\u7406\u68c0\u6d4b\u8d85\u65f6" });
        return;
      }

      if (error && !stdout) {
        resolve({ ok: false, message: normalizeNetworkError(error) });
        return;
      }

      const parsed = parseJsonObject(stdout);
      if (!parsed) {
        resolve({ ok: false, message: "\u7cfb\u7edf\u4ee3\u7406\u68c0\u6d4b\u65e0\u6709\u6548\u8fd4\u56de" });
        return;
      }

      const statusCode = Number(parsed.statusCode || 0);
      const ok = Boolean(parsed.ok) && statusCode >= 200 && statusCode < 400;
      resolve({
        ok,
        statusCode: Number.isFinite(statusCode) && statusCode > 0 ? statusCode : null,
        message: parsed.message || ""
      });
    });
  });
}

function parseJsonObject(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeNetworkError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return "\u8fde\u63a5\u8d85\u65f6";
  }

  const code = error?.cause?.code || error?.code;
  if (code === "ENOTFOUND") return "DNS \u89e3\u6790\u5931\u8d25";
  if (code === "ECONNREFUSED") return "\u8fde\u63a5\u88ab\u62d2\u7edd";
  if (code === "ECONNRESET") return "\u8fde\u63a5\u88ab\u91cd\u7f6e";
  if (code === "ETIMEDOUT") return "\u8fde\u63a5\u8d85\u65f6";

  return error?.message || "\u8bf7\u6c42\u5931\u8d25";
}

module.exports = {
  checkSystemHealth
};