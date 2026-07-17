const { checkExternalConnectivity } = require("./proxy-connectivity");

const DEFAULT_TIMEOUT_MS = 3500;
const NETWORK_TARGET = "https://www.baidu.com";

async function checkSystemHealth(config = {}) {
  const checkedAt = new Date().toISOString();
  const serverConfig = config.server || config;
  const externalConfig = config.health?.externalConnectivity || {};
  const [network, external] = await Promise.all([
    checkHttpTarget({
      target: NETWORK_TARGET,
      okLabel: "连通",
      failureState: "down",
      failureLabel: "不可达"
    }),
    checkExternalConnectivity({
      ...externalConfig,
      excludePorts: [Number(serverConfig.port || 3344)]
    })
  ]);

  return {
    server: {
      state: "ok",
      label: "运行中",
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
      label: "受限",
      target: options.target,
      statusCode: response.status,
      latencyMs,
      message: `HTTP ${response.status}`,
      checkedAt
    };
  } catch (error) {
    return {
      state: options.failureState,
      label: options.failureLabel,
      target: options.target,
      latencyMs: Date.now() - startedAt,
      message: normalizeNetworkError(error),
      checkedAt
    };
  }
}

function normalizeNetworkError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "连接超时";
  const code = error?.cause?.code || error?.code;
  if (code === "ENOTFOUND") return "DNS 解析失败";
  if (code === "ECONNREFUSED") return "连接被拒绝";
  if (code === "ECONNRESET") return "连接被重置";
  if (code === "ETIMEDOUT") return "连接超时";
  return error?.message || "请求失败";
}

module.exports = {
  checkHttpTarget,
  checkSystemHealth
};