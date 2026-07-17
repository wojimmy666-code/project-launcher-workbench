const net = require("node:net");
const tls = require("node:tls");
const { execFile } = require("node:child_process");
const { TextDecoder } = require("node:util");

const DEFAULT_TARGETS = [
  "https://www.google.com/generate_204",
  "https://www.gstatic.com/generate_204"
];
const DEFAULT_BROWSER_PROBE_URL = "https://www.google.com/generate_204";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_FAILURE_THRESHOLD = 2;
const ROUTE_CACHE_TTL_MS = 5 * 60 * 1000;
const LAST_SUCCESS_MAX_AGE_MS = 10 * 60 * 1000;
const DISCOVERY_PROTOCOL_TIMEOUT_MS = 400;
const DISCOVERY_ROUTE_TIMEOUT_MS = 1800;
const MAX_DISCOVERY_CANDIDATES = 40;
const COMMON_PROXY_PORTS = [1080, 10808, 10809, 7890, 7891, 7897, 20170, 20171, 2080, 8080, 8888];

let routeCache = null;
let lastSuccess = null;
let consecutiveFailures = 0;
let activeConfigKey = null;

async function checkExternalConnectivity(config = {}, dependencies = {}) {
  const options = normalizeExternalConfig(config);
  const configKey = JSON.stringify({ mode: options.mode, proxy: options.proxy, targets: options.targets });
  if (activeConfigKey !== configKey) {
    resetExternalConnectivityState();
    activeConfigKey = configKey;
  }

  const now = dependencies.now || Date.now;
  const startedAt = now();
  const testRouteFn = dependencies.testRoute || testRoute;
  const getConfiguredProxyCandidatesFn = dependencies.getConfiguredProxyCandidates || getConfiguredProxyCandidates;
  const discoverLocalProxyCandidatesFn = dependencies.discoverLocalProxyCandidates || discoverLocalProxyCandidates;
  const findWorkingLocalProxyFn = dependencies.findWorkingLocalProxy || findWorkingLocalProxy;
  const getProcessNameFn = dependencies.getProcessName || getProcessName;
  const attempts = [];
  const seenRoutes = new Set();

  const tryRoute = async (route, timeoutMs = options.timeoutMs, targets = options.targets) => {
    if (!route) return null;
    const key = routeKey(route);
    if (seenRoutes.has(key)) return null;
    seenRoutes.add(key);
    const routeStartedAt = now();
    try {
      const result = await testRouteFn(route, targets, timeoutMs);
      attempts.push({ route: describeRoute(route), ok: Boolean(result?.ok), message: result?.message || "" });
      if (!result?.ok) return null;
      return {
        route,
        result: {
          ...result,
          latencyMs: Number.isFinite(Number(result.latencyMs)) ? Number(result.latencyMs) : now() - routeStartedAt
        }
      };
    } catch (error) {
      attempts.push({ route: describeRoute(route), ok: false, message: normalizeNetworkError(error) });
      return null;
    }
  };

  let success = null;
  let deferredSystemRoutes = [];
  if (options.mode === "proxy") {
    const route = parseProxyUrl(options.proxy, "manual");
    if (!route) return failureStatus(options, startedAt, now, attempts, "代理模式未配置有效的代理地址");
    success = await tryRoute(route);
  } else if (options.mode === "direct") {
    success = await tryRoute({ kind: "direct", source: "direct" });
  } else {
    if (routeCache && routeCache.expiresAt > now()) {
      success = await tryRoute(routeCache.route);
      if (!success) routeCache = null;
    }
    if (!success) success = await tryRoute({ kind: "direct", source: "direct" });
    if (!success) {
      const configuredRoutes = await getConfiguredProxyCandidatesFn(options).catch(() => []);
      deferredSystemRoutes = configuredRoutes.filter((route) => route.kind === "system-proxy");
      for (const route of configuredRoutes.filter((candidate) => candidate.kind !== "system-proxy")) {
        success = await tryRoute(route);
        if (success) break;
      }
    }
    if (!success) {
      const candidates = await discoverLocalProxyCandidatesFn({
        excludePorts: options.excludePorts,
        maxCandidates: options.maxDiscoveryCandidates
      }).catch(() => []);
      const localResult = await findWorkingLocalProxyFn(candidates, options.targets, {
        protocolTimeoutMs: options.discoveryProtocolTimeoutMs,
        routeTimeoutMs: options.discoveryRouteTimeoutMs,
        testRoute: testRouteFn
      }).catch((error) => ({ ok: false, message: normalizeNetworkError(error) }));
      attempts.push({
        route: `本地监听端口（${candidates.length} 个候选）`,
        ok: Boolean(localResult?.ok),
        message: localResult?.message || ""
      });
      if (localResult?.ok) success = { route: localResult.route, result: localResult };
    }
    if (!success) {
      for (const route of deferredSystemRoutes) {
        success = await tryRoute(route);
        if (success) break;
      }
    }
  }

  if (!success) return failureStatus(options, startedAt, now, attempts);
  const route = success.route;
  routeCache = { route: { ...route }, expiresAt: now() + options.routeCacheTtlMs };
  if (route.pid && !route.processName) {
    getProcessNameFn(route.pid).then((name) => {
      if (!name || !routeCache || routeKey(routeCache.route) !== routeKey(route)) return;
      route.processName = name;
      routeCache.route.processName = name;
    }).catch(() => {});
  }
  consecutiveFailures = 0;
  const status = successStatus(options, startedAt, now, route, success.result);
  lastSuccess = { ...status, at: now(), route: { ...route } };
  return status;
}

function normalizeExternalConfig(config = {}) {
  const requestedMode = String(config.mode || "auto").toLowerCase();
  const mode = ["auto", "direct", "proxy"].includes(requestedMode) ? requestedMode : "auto";
  const targets = (Array.isArray(config.targets) ? config.targets : DEFAULT_TARGETS)
    .map(String).map((value) => value.trim()).filter(isHttpUrl);
  return {
    mode,
    proxy: String(config.proxy || "").trim() || null,
    targets: targets.length ? targets : [...DEFAULT_TARGETS],
    browserProbeUrl: isHttpUrl(config.browserProbeUrl) ? config.browserProbeUrl : DEFAULT_BROWSER_PROBE_URL,
    timeoutMs: positiveNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS),
    failureThreshold: Math.max(1, positiveNumber(config.failureThreshold, DEFAULT_FAILURE_THRESHOLD)),
    routeCacheTtlMs: positiveNumber(config.routeCacheTtlMs, ROUTE_CACHE_TTL_MS),
    discoveryProtocolTimeoutMs: positiveNumber(config.discoveryProtocolTimeoutMs, DISCOVERY_PROTOCOL_TIMEOUT_MS),
    discoveryRouteTimeoutMs: positiveNumber(config.discoveryRouteTimeoutMs, DISCOVERY_ROUTE_TIMEOUT_MS),
    maxDiscoveryCandidates: Math.max(1, positiveNumber(config.maxDiscoveryCandidates, MAX_DISCOVERY_CANDIDATES)),
    excludePorts: new Set((config.excludePorts || []).map(Number).filter(Number.isInteger))
  };
}

function successStatus(options, startedAt, now, route, result) {
  const label = route.kind === "direct" ? "直连" : route.source === "windows" ? "系统代理" : "代理连通";
  const viaLabel = formatRouteLabel(route);
  const endpoint = route.kind === "proxy" ? formatProxyEndpoint(route) : null;
  const processText = route.processName ? `（${route.processName}）` : "";
  const message = route.kind === "direct"
    ? "后台可直接访问外网"
    : `通过 ${viaLabel}${endpoint ? ` ${endpoint}` : ""}${processText}`;
  return {
    state: "ok", label, target: result.target, statusCode: result.statusCode,
    latencyMs: Number(result.latencyMs || now() - startedAt), message,
    via: route.kind === "direct" ? "direct" : route.source || route.protocol,
    viaLabel, proxyProtocol: route.protocol || null, proxyEndpoint: endpoint,
    proxyPid: route.pid || null, proxyProcess: route.processName || null,
    browserProbeUrl: options.browserProbeUrl, checkedAt: new Date().toISOString()
  };
}

function failureStatus(options, startedAt, now, attempts, explicitMessage = "") {
  consecutiveFailures += 1;
  const recentSuccess = lastSuccess && now() - lastSuccess.at <= LAST_SUCCESS_MAX_AGE_MS;
  const retrying = recentSuccess && consecutiveFailures < options.failureThreshold;
  const attemptMessage = attempts.filter((item) => item.message).slice(-3)
    .map((item) => `${item.route}：${item.message}`).join("；");
  const message = explicitMessage || attemptMessage || "未找到可用的外网访问路径";
  return {
    state: retrying ? "degraded" : "down", label: retrying ? "复检中" : "不可达",
    target: options.targets[0], latencyMs: now() - startedAt,
    message: retrying ? `最近一次通过 ${lastSuccess.viaLabel || lastSuccess.label} 连通，本次检测失败：${message}` : message,
    attempts: attempts.map(({ route, ok }) => ({ route, ok })), consecutiveFailures,
    browserProbeUrl: options.browserProbeUrl, checkedAt: new Date().toISOString()
  };
}

async function testRoute(route, targets, timeoutMs) {
  let lastMessage = "请求失败";
  for (const target of targets) {
    const result = route.kind === "direct"
      ? await requestDirect(target, timeoutMs)
      : route.kind === "system-proxy"
        ? await checkWithWindowsSystemProxy(target, timeoutMs)
        : await requestThroughProxy(route, target, timeoutMs);
    if (result.ok) return { ...result, target };
    lastMessage = result.message || lastMessage;
  }
  return { ok: false, message: lastMessage };
}

async function requestDirect(target, timeoutMs) {
  const startedAt = Date.now();
  try {
    const response = await fetch(target, {
      method: "GET", cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(timeoutMs)
    });
    await response.body?.cancel?.();
    const ok = response.status >= 200 && response.status < 400;
    return { ok, statusCode: response.status, latencyMs: Date.now() - startedAt, message: ok ? "" : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, message: normalizeNetworkError(error) };
  }
}

async function requestThroughProxy(route, target, timeoutMs) {
  const url = new URL(target);
  if (url.protocol !== "https:") return { ok: false, message: "代理健康检查仅支持 HTTPS 目标" };
  const startedAt = Date.now();
  let socket;
  try {
    socket = route.protocol === "socks5"
      ? await createSocksTunnel(route, url.hostname, Number(url.port || 443), timeoutMs)
      : await createHttpConnectTunnel(route, url.hostname, Number(url.port || 443), timeoutMs);
    const result = await requestHttpsOverSocket(socket, url, timeoutMs);
    return { ...result, latencyMs: Date.now() - startedAt };
  } catch (error) {
    socket?.destroy?.();
    return { ok: false, latencyMs: Date.now() - startedAt, message: normalizeNetworkError(error) };
  }
}
async function createSocksTunnel(route, targetHost, targetPort, timeoutMs) {
  const socket = await connectSocket(route.host, route.port, timeoutMs, false);
  const reader = new SocketReader(socket);
  try {
    const hasCredentials = Boolean(route.username || route.password);
    socket.write(Buffer.from(hasCredentials ? [5, 2, 0, 2] : [5, 1, 0]));
    const greeting = await reader.readBytes(2, timeoutMs);
    if (greeting[0] !== 5 || greeting[1] === 255) throw new Error("SOCKS5 不支持可用认证方式");
    if (greeting[1] === 2) {
      const username = Buffer.from(route.username || "", "utf8");
      const password = Buffer.from(route.password || "", "utf8");
      if (username.length > 255 || password.length > 255) throw new Error("SOCKS5 认证信息过长");
      socket.write(Buffer.concat([
        Buffer.from([1, username.length]), username,
        Buffer.from([password.length]), password
      ]));
      const auth = await reader.readBytes(2, timeoutMs);
      if (auth[1] !== 0) throw new Error("SOCKS5 认证失败");
    } else if (greeting[1] !== 0) {
      throw new Error(`SOCKS5 返回未知认证方式 ${greeting[1]}`);
    }

    const hostname = Buffer.from(targetHost, "utf8");
    if (hostname.length > 255) throw new Error("目标主机名过长");
    socket.write(Buffer.concat([
      Buffer.from([5, 1, 0, 3, hostname.length]), hostname,
      Buffer.from([(targetPort >> 8) & 255, targetPort & 255])
    ]));
    const response = await reader.readBytes(4, timeoutMs);
    if (response[0] !== 5 || response[1] !== 0) throw new Error(`SOCKS5 连接失败，代码 ${response[1]}`);
    if (response[3] === 1) {
      await reader.readBytes(6, timeoutMs);
    } else if (response[3] === 3) {
      const length = await reader.readBytes(1, timeoutMs);
      await reader.readBytes(length[0] + 2, timeoutMs);
    } else if (response[3] === 4) {
      await reader.readBytes(18, timeoutMs);
    } else {
      throw new Error("SOCKS5 返回无效地址类型");
    }
    reader.release();
    return socket;
  } catch (error) {
    reader.release();
    socket.destroy();
    throw error;
  }
}

async function createHttpConnectTunnel(route, targetHost, targetPort, timeoutMs) {
  const socket = await connectSocket(route.host, route.port, timeoutMs, route.protocol === "https");
  const reader = new SocketReader(socket);
  try {
    const auth = route.username || route.password
      ? `Proxy-Authorization: Basic ${Buffer.from(`${route.username || ""}:${route.password || ""}`).toString("base64")}\r\n`
      : "";
    socket.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`
      + auth + "Proxy-Connection: keep-alive\r\nConnection: keep-alive\r\n\r\n"
    );
    const header = await reader.readUntil(Buffer.from("\r\n\r\n"), 64 * 1024, timeoutMs);
    const statusLine = header.toString("latin1").split("\r\n")[0] || "";
    const statusCode = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1] || 0);
    if (statusCode !== 200) throw new Error(`HTTP 代理 CONNECT 返回 ${statusCode || "无效响应"}`);
    reader.release();
    return socket;
  } catch (error) {
    reader.release();
    socket.destroy();
    throw error;
  }
}

async function requestHttpsOverSocket(socket, url, timeoutMs) {
  const secure = tls.connect({ socket, servername: url.hostname, rejectUnauthorized: true });
  await waitForSocketEvent(secure, "secureConnect", timeoutMs);
  const reader = new SocketReader(secure);
  try {
    const requestPath = `${url.pathname || "/"}${url.search || ""}`;
    secure.write(
      `GET ${requestPath} HTTP/1.1\r\nHost: ${url.host}\r\n`
      + "User-Agent: ProjectLauncherHealth/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    const header = await reader.readUntil(Buffer.from("\r\n\r\n"), 64 * 1024, timeoutMs);
    const statusLine = header.toString("latin1").split("\r\n")[0] || "";
    const statusCode = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1] || 0);
    const ok = statusCode >= 200 && statusCode < 400;
    return { ok, statusCode, message: ok ? "" : `HTTP ${statusCode || "无效响应"}` };
  } finally {
    reader.release();
    secure.destroy();
  }
}

async function connectSocket(host, port, timeoutMs, secure) {
  const socket = secure
    ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true })
    : net.connect({ host, port });
  try {
    await waitForSocketEvent(socket, secure ? "secureConnect" : "connect", timeoutMs);
    socket.setNoDelay(true);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function waitForSocketEvent(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("连接超时")), timeoutMs);
    const onEvent = () => finish();
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("连接已关闭"));
    const finish = (error) => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.off("error", onError);
      socket.off("close", onClose);
      error ? reject(error) : resolve();
    };
    socket.once(event, onEvent);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.error = null;
    this.onData = (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.flush(); };
    this.onError = (error) => { this.error = error; this.flush(); };
    this.onClose = () => { this.error = this.error || new Error("连接已关闭"); this.flush(); };
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  readBytes(length, timeoutMs) {
    return this.waitFor(
      () => this.buffer.length >= length,
      () => {
        const value = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        return value;
      },
      timeoutMs
    );
  }

  readUntil(marker, maxBytes, timeoutMs) {
    return this.waitFor(
      () => this.buffer.indexOf(marker) !== -1 || this.buffer.length > maxBytes,
      () => {
        const index = this.buffer.indexOf(marker);
        if (index === -1) throw new Error("代理响应头过大");
        const end = index + marker.length;
        const value = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        return value;
      },
      timeoutMs
    );
  }

  waitFor(predicate, consume, timeoutMs) {
    if (this.waiter) return Promise.reject(new Error("存在未完成的读取操作"));
    if (this.error) return Promise.reject(this.error);
    if (predicate()) {
      try { return Promise.resolve(consume()); } catch (error) { return Promise.reject(error); }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.timer === timer) this.waiter = null;
        reject(new Error("代理响应超时"));
      }, timeoutMs);
      this.waiter = { predicate, consume, resolve, reject, timer };
    });
  }

  flush() {
    const waiter = this.waiter;
    if (!waiter) return;
    if (this.error) {
      clearTimeout(waiter.timer);
      this.waiter = null;
      waiter.reject(this.error);
      return;
    }
    if (!waiter.predicate()) return;
    clearTimeout(waiter.timer);
    this.waiter = null;
    try { waiter.resolve(waiter.consume()); } catch (error) { waiter.reject(error); }
  }

  release() {
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(new Error("读取已取消"));
      this.waiter = null;
    }
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    if (this.buffer.length && !this.socket.destroyed) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
  }
}
async function getConfiguredProxyCandidates() {
  const routes = [];
  const values = [
    [process.env.HTTPS_PROXY || process.env.https_proxy, "environment"],
    [process.env.ALL_PROXY || process.env.all_proxy, "environment"],
    [process.env.HTTP_PROXY || process.env.http_proxy, "environment"]
  ];
  for (const [value, source] of values) {
    const route = parseProxyUrl(value, source);
    if (route) routes.push(route);
  }
  if (process.platform === "win32") routes.push(...await getWindowsProxyCandidates());
  return dedupeRoutes(routes);
}

async function getWindowsProxyCandidates() {
  const routes = [];
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const connectionsKey = `${key}\\Connections`;
  let registryText = "";
  let connectionsText = "";
  try { registryText = (await execFilePromise("reg.exe", ["query", key])).stdout; } catch {}
  try { connectionsText = (await execFilePromise("reg.exe", ["query", connectionsKey, "/v", "DefaultConnectionSettings"])).stdout; } catch {}
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(registryText);
  const proxyServer = registryText.match(/ProxyServer\s+REG_\w+\s+(.+)$/im)?.[1]?.trim() || "";
  const pacUrl = registryText.match(/AutoConfigURL\s+REG_\w+\s+(.+)$/im)?.[1]?.trim() || "";
  const connectionBinary = connectionsText.match(/DefaultConnectionSettings\s+REG_BINARY\s+([0-9a-f]+)/i)?.[1] || "";
  const connectionFlags = connectionBinary.length >= 18 ? Number.parseInt(connectionBinary.slice(16, 18), 16) : 0;
  const autoDetect = Boolean(connectionFlags & 0x08);
  if (enabled && proxyServer) routes.push(...parseWindowsProxyServer(proxyServer));
  if (enabled || pacUrl || autoDetect) {
    routes.push({ kind: "system-proxy", source: "windows", pacUrl: pacUrl || null, autoDetect });
  }

  try {
    const output = (await execFilePromise("netsh", ["winhttp", "show", "proxy"])).stdout;
    const matches = String(output || "").matchAll(/(?:(https?|socks5?):\/\/)?(127\.\d+\.\d+\.\d+|localhost|\[[^\]]+\]|[a-z0-9.-]+):(\d{2,5})/gi);
    for (const match of matches) {
      const route = parseProxyUrl(`${match[1] || "http"}://${match[2]}:${match[3]}`, "windows");
      if (route) routes.push(route);
    }
  } catch {}
  return dedupeRoutes(routes);
}

function parseWindowsProxyServer(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (!text.includes("=")) {
    const route = parseProxyUrl(text, "windows");
    return route ? [route] : [];
  }
  const routes = [];
  for (const item of text.split(";")) {
    const [rawProtocol, rawEndpoint] = item.split("=", 2);
    if (!rawEndpoint) continue;
    const protocol = rawProtocol.trim().toLowerCase();
    const scheme = protocol.startsWith("socks") ? "socks5" : protocol === "https" ? "https" : "http";
    const route = parseProxyUrl(`${scheme}://${rawEndpoint.trim()}`, "windows");
    if (route) routes.push(route);
  }
  return routes;
}

function parseProxyUrl(value, source = "configured") {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(normalized);
    let protocol = url.protocol.replace(":", "").toLowerCase();
    if (protocol === "socks" || protocol === "socks5h") protocol = "socks5";
    if (!["http", "https", "socks5"].includes(protocol)) return null;
    const port = Number(url.port || (protocol === "https" ? 443 : protocol === "socks5" ? 1080 : 80));
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      kind: "proxy", protocol, host: url.hostname, port,
      username: decodeURIComponent(url.username || ""), password: decodeURIComponent(url.password || ""), source
    };
  } catch {
    return null;
  }
}

async function discoverLocalProxyCandidates(options = {}) {
  if (process.platform !== "win32") return [];
  const result = await execFilePromise("netstat", ["-ano", "-p", "tcp"]);
  return parseNetstatListeners(result.stdout, options);
}

function parseNetstatListeners(output, options = {}) {
  const excludePorts = options.excludePorts instanceof Set
    ? options.excludePorts
    : new Set((options.excludePorts || []).map(Number));
  const maxCandidates = Math.max(1, Number(options.maxCandidates || MAX_DISCOVERY_CANDIDATES));
  const candidates = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== "TCP") continue;
    const stateIndex = parts.findIndex((part) => part.toUpperCase() === "LISTENING");
    if (stateIndex === -1) continue;
    const address = parseAddress(parts[1]);
    const pid = Number(parts[stateIndex + 1]);
    if (!address || !isLocalListenerHost(address.host)) continue;
    if (!Number.isInteger(address.port) || address.port < 1024 || excludePorts.has(address.port)) continue;
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const host = address.host === "::1" ? "::1" : "127.0.0.1";
    const key = `${host}:${address.port}`;
    if (!candidates.has(key)) candidates.set(key, { host, port: address.port, pid });
  }
  return [...candidates.values()]
    .sort((left, right) => candidatePriority(left) - candidatePriority(right) || left.port - right.port)
    .slice(0, maxCandidates);
}

async function findWorkingLocalProxy(candidates, targets, options = {}) {
  if (!candidates.length) return { ok: false, message: "没有本机监听端口候选" };
  const testRouteFn = options.testRoute || testRoute;
  const protocolTimeoutMs = Number(options.protocolTimeoutMs || DISCOVERY_PROTOCOL_TIMEOUT_MS);
  const routeTimeoutMs = Number(options.routeTimeoutMs || DISCOVERY_ROUTE_TIMEOUT_MS);
  const primaryTarget = [targets[0] || DEFAULT_TARGETS[0]];
  const protocolResults = await mapWithConcurrency(candidates, 20, async (candidate) => ({
    candidate,
    socks: await probeSocks5Protocol(candidate, protocolTimeoutMs)
  }));
  const socksRoutes = protocolResults.filter((item) => item.socks).map((item) => ({
    kind: "proxy", protocol: "socks5", source: "auto", ...item.candidate
  }));
  const socksResult = await findSuccessfulRoute(socksRoutes, 6, (route) => testRouteFn(route, primaryTarget, routeTimeoutMs));
  if (socksResult) return { ...socksResult.result, ok: true, route: socksResult.route };

  const httpRoutes = protocolResults.filter((item) => !item.socks).map((item) => ({
    kind: "proxy", protocol: "http", source: "auto", ...item.candidate
  }));
  const httpResult = await findSuccessfulRoute(httpRoutes, 16, (route) => testRouteFn(route, primaryTarget, routeTimeoutMs));
  if (httpResult) return { ...httpResult.result, ok: true, route: httpResult.route };
  return { ok: false, message: "候选监听端口均未通过代理握手与外网请求" };
}

async function probeSocks5Protocol(candidate, timeoutMs = DISCOVERY_PROTOCOL_TIMEOUT_MS) {
  let socket;
  try {
    socket = await connectSocket(candidate.host, candidate.port, timeoutMs, false);
    const reader = new SocketReader(socket);
    socket.write(Buffer.from([5, 1, 0]));
    const response = await reader.readBytes(2, timeoutMs);
    reader.release();
    return response[0] === 5 && response[1] !== 255;
  } catch {
    return false;
  } finally {
    socket?.destroy?.();
  }
}

async function findSuccessfulRoute(routes, concurrency, worker) {
  for (let index = 0; index < routes.length; index += concurrency) {
    const batch = routes.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (route) => {
      try { return { route, result: await worker(route) }; }
      catch (error) { return { route, result: { ok: false, message: normalizeNetworkError(error) } }; }
    }));
    const success = results.find((item) => item.result?.ok);
    if (success) return success;
  }
  return null;
}

function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  return Promise.all(workers).then(() => results);
}

function parseAddress(value) {
  const text = String(value || "");
  if (text.startsWith("[")) {
    const match = text.match(/^\[([^\]]+)\]:(\d+)$/);
    return match ? { host: match[1].split("%")[0], port: Number(match[2]) } : null;
  }
  const index = text.lastIndexOf(":");
  return index === -1 ? null : { host: text.slice(0, index), port: Number(text.slice(index + 1)) };
}

function isLocalListenerHost(host) {
  const value = String(host || "").toLowerCase();
  return value === "0.0.0.0" || value === "::" || value === "::1" || value === "localhost" || value.startsWith("127.");
}

function candidatePriority(candidate) {
  const index = COMMON_PROXY_PORTS.indexOf(candidate.port);
  return index === -1 ? 1000 + candidate.port : index;
}
async function checkWithWindowsSystemProxy(target, timeoutMs) {
  if (process.platform !== "win32") return { ok: false, message: "当前系统不支持 Windows 代理检测" };
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
  ].join("\r\n");
  try {
    const startedAt = Date.now();
    const result = await execFilePromise("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      timeout: timeoutMs + 1200,
      env: {
        ...process.env,
        PROJECT_LAUNCHER_HEALTH_TARGET: target,
        PROJECT_LAUNCHER_HEALTH_TIMEOUT_SECONDS: String(timeoutSeconds)
      }
    });
    const parsed = parseJsonObject(result.stdout);
    const statusCode = Number(parsed?.statusCode || 0);
    const ok = Boolean(parsed?.ok) && statusCode >= 200 && statusCode < 400;
    return {
      ok, statusCode: statusCode || null, latencyMs: Date.now() - startedAt,
      message: parsed?.message || (ok ? "" : "系统代理检测失败")
    };
  } catch (error) {
    return { ok: false, message: normalizeNetworkError(error) };
  }
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      windowsHide: true, encoding: "buffer", maxBuffer: 10 * 1024 * 1024, ...options
    }, (error, stdout, stderr) => {
      const decodedStdout = decodeCommandOutput(stdout);
      const decodedStderr = decodeCommandOutput(stderr);
      if (error) {
        error.stdout = decodedStdout;
        error.stderr = decodedStderr;
        reject(error);
        return;
      }
      resolve({ stdout: decodedStdout, stderr: decodedStderr });
    });
  });
}

function decodeCommandOutput(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || "");
  if (!buffer.length) return "";
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\ufffd")) return utf8;
  try { return new TextDecoder("gb18030").decode(buffer); } catch { return utf8; }
}

async function getProcessName(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0 || process.platform !== "win32") return "";
  try {
    const result = await execFilePromise("tasklist", ["/FI", `PID eq ${Number(pid)}`, "/FO", "CSV", "/NH"]);
    const name = String(result.stdout || "").match(/^"([^"]+)"/m)?.[1] || "";
    if (name) return name;
  } catch {}

  try {
    const result = await execFilePromise("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).ProcessName`
    ]);
    return String(result.stdout || "").trim();
  } catch {
    return "";
  }
}

function routeKey(route) {
  if (route.kind === "direct" || route.kind === "system-proxy") return `${route.kind}:${route.source || ""}`;
  return `${route.protocol}:${route.host}:${route.port}:${route.source || ""}`;
}

function describeRoute(route) {
  if (route.kind === "direct") return "直连";
  if (route.kind === "system-proxy") return "Windows 系统代理/PAC";
  return `${formatRouteLabel(route)} ${formatProxyEndpoint(route)}`;
}

function formatRouteLabel(route) {
  if (route.kind === "direct") return "直连";
  if (route.kind === "system-proxy") return "Windows 系统代理/PAC";
  if (route.protocol === "socks5") return "SOCKS5";
  if (route.protocol === "https") return "HTTPS 代理";
  return "HTTP 代理";
}

function formatProxyEndpoint(route) {
  if (!route?.host || !route?.port) return null;
  return `${route.host.includes(":") ? `[${route.host}]` : route.host}:${route.port}`;
}

function dedupeRoutes(routes) {
  const seen = new Set();
  return routes.filter((route) => {
    const key = routeKey(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseJsonObject(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

function normalizeNetworkError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError" || error?.killed) return "连接超时";
  const code = error?.cause?.code || error?.code;
  if (code === "ENOTFOUND") return "DNS 解析失败";
  if (code === "ECONNREFUSED") return "连接被拒绝";
  if (code === "ECONNRESET") return "连接被重置";
  if (code === "ETIMEDOUT") return "连接超时";
  return error?.message || "请求失败";
}

function isHttpUrl(value) {
  try { return ["http:", "https:"].includes(new URL(String(value || "")).protocol); }
  catch { return false; }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function resetExternalConnectivityState() {
  routeCache = null;
  lastSuccess = null;
  consecutiveFailures = 0;
  activeConfigKey = null;
}

module.exports = {
  checkExternalConnectivity,
  discoverLocalProxyCandidates,
  findWorkingLocalProxy,
  getConfiguredProxyCandidates,
  normalizeExternalConfig,
  parseNetstatListeners,
  parseProxyUrl,
  probeSocks5Protocol,
  requestThroughProxy,
  resetExternalConnectivityState,
  testRoute
};
