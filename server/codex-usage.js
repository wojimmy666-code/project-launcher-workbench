const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CACHE_VERSION = 2;
const USAGE_KIND = "codex_weekly";
const CODEX_LIMIT_ID = "codex";
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const HOUR_MS = 60 * 60 * 1000;
const INITIAL_TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_RECENT_FILE_COUNT = 30;
const UNAVAILABLE_RETRY_MS = HOUR_MS;

function getUsageRefreshIntervalMs(usedPercent) {
  const value = Number(usedPercent);
  if (!Number.isFinite(value)) return UNAVAILABLE_RETRY_MS;
  if (value < 50) return 6 * HOUR_MS;
  if (value < 80) return 2 * HOUR_MS;
  if (value < 95) return 30 * 60 * 1000;
  return 10 * 60 * 1000;
}

function normalizeRateLimitEvent(event) {
  if (event?.type !== "event_msg" || event?.payload?.type !== "token_count") return null;

  const rateLimits = event.payload.rate_limits;
  if (rateLimits?.limit_id !== CODEX_LIMIT_ID) return null;

  const weeklyLimit = [rateLimits.secondary, rateLimits.primary].find((limit) => (
    Number(limit?.window_minutes) === WEEKLY_WINDOW_MINUTES
  ));
  const observedAt = parseDate(event.timestamp);
  const usedPercent = Number(weeklyLimit?.used_percent);
  const resetSeconds = Number(weeklyLimit?.resets_at);

  if (!weeklyLimit || !observedAt || !Number.isFinite(usedPercent)) return null;

  return {
    cacheVersion: CACHE_VERSION,
    usageKind: USAGE_KIND,
    available: true,
    limitId: CODEX_LIMIT_ID,
    limitName: "Codex",
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes: WEEKLY_WINDOW_MINUTES,
    resetsAt: Number.isFinite(resetSeconds)
      ? new Date(resetSeconds * 1000).toISOString()
      : null,
    observedAt,
    stale: false
  };
}

function parseLatestRateLimit(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || !line.includes('"rate_limits"')) continue;

    try {
      const normalized = normalizeRateLimitEvent(JSON.parse(line));
      if (normalized) return normalized;
    } catch {
      // Ignore partial or unrelated JSONL records while scanning backwards.
    }
  }
  return null;
}

async function readLatestRateLimitFromFile(filePath, options = {}) {
  const initialBytes = options.initialBytes || INITIAL_TAIL_BYTES;
  const maxBytes = options.maxBytes || MAX_TAIL_BYTES;
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) return null;

  const handle = await fsp.open(filePath, "r");
  try {
    let bytesToRead = Math.min(stat.size, initialBytes);
    while (bytesToRead > 0) {
      const start = Math.max(0, stat.size - bytesToRead);
      const buffer = Buffer.allocUnsafe(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.toString("utf8");

      if (start > 0) {
        const firstNewline = text.indexOf("\n");
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
      }

      const result = parseLatestRateLimit(text);
      if (result) return result;
      if (start === 0 || bytesToRead >= maxBytes) return null;
      bytesToRead = Math.min(stat.size, maxBytes, bytesToRead * 2);
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function findRecentSessionFiles(sessionsDir, maxFiles = DEFAULT_RECENT_FILE_COUNT) {
  const recent = [];
  const pending = [sessionsDir];

  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".jsonl") continue;

      try {
        const stat = await fsp.stat(entryPath);
        recent.push({ path: entryPath, mtimeMs: stat.mtimeMs });
      } catch {
        // The session may have been rotated between readdir and stat.
      }
    }
  }

  return recent
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles)
    .map((entry) => entry.path);
}

async function scanCodexUsage(options = {}) {
  const sessionsDir = options.sessionsDir || getDefaultSessionsDir();
  const files = options.files || await findRecentSessionFiles(
    sessionsDir,
    options.maxFiles || DEFAULT_RECENT_FILE_COUNT
  );
  const candidates = [];

  for (const filePath of files) {
    try {
      const result = await readLatestRateLimitFromFile(filePath, options);
      if (result) candidates.push(result);
    } catch {
      // One inaccessible session must not hide valid data from other sessions.
    }
  }

  return candidates.sort((left, right) => (
    Date.parse(right.observedAt) - Date.parse(left.observedAt)
  ))[0] || null;
}

function createCodexUsageService(options = {}) {
  const sessionsDir = options.sessionsDir || getDefaultSessionsDir();
  const cachePath = options.cachePath === undefined ? getDefaultCachePath() : options.cachePath;
  const now = options.now || (() => Date.now());
  const scanner = options.scan || (() => scanCodexUsage({ sessionsDir }));
  let memoryCache = null;
  let pendingRefresh = null;
  let diskCacheLoaded = false;

  async function getUsage(request = {}) {
    const currentTime = now();
    if (!diskCacheLoaded) {
      memoryCache = await readUsageCache(cachePath);
      diskCacheLoaded = true;
    }

    if (!request.force && isCacheFresh(memoryCache, currentTime)) {
      return { ...memoryCache, cached: true };
    }

    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = refreshUsage(currentTime).finally(() => {
      pendingRefresh = null;
    });
    return pendingRefresh;
  }

  async function refreshUsage(currentTime) {
    const checkedAt = new Date(currentTime).toISOString();
    try {
      const latest = await scanner();
      if (latest) {
        const refreshIntervalMs = getUsageRefreshIntervalMs(latest.usedPercent);
        memoryCache = {
          ...latest,
          checkedAt,
          stale: false,
          cached: false,
          refreshIntervalMs,
          nextRefreshAt: new Date(currentTime + refreshIntervalMs).toISOString()
        };
        await writeUsageCache(cachePath, memoryCache);
        return { ...memoryCache };
      }
    } catch (error) {
      return useStaleOrUnavailable(error.message, currentTime, checkedAt);
    }

    return useStaleOrUnavailable("No Codex rate-limit data was found", currentTime, checkedAt);
  }

  function useStaleOrUnavailable(message, currentTime, checkedAt) {
    const nextRefreshAt = new Date(currentTime + UNAVAILABLE_RETRY_MS).toISOString();
    if (memoryCache?.available) {
      memoryCache = {
        ...memoryCache,
        checkedAt,
        stale: true,
        cached: true,
        message,
        refreshIntervalMs: UNAVAILABLE_RETRY_MS,
        nextRefreshAt
      };
      return { ...memoryCache };
    }

    memoryCache = {
      cacheVersion: CACHE_VERSION,
      usageKind: USAGE_KIND,
      available: false,
      message,
      checkedAt,
      observedAt: null,
      stale: true,
      cached: false,
      refreshIntervalMs: UNAVAILABLE_RETRY_MS,
      nextRefreshAt
    };
    return { ...memoryCache };
  }

  return { getUsage };
}

function isCacheFresh(cache, currentTime) {
  if (!cache?.nextRefreshAt || Date.parse(cache.nextRefreshAt) <= currentTime) return false;
  if (cache.resetsAt && Date.parse(cache.resetsAt) <= currentTime) return false;
  return true;
}

async function readUsageCache(cachePath) {
  if (!cachePath) return null;
  try {
    const parsed = JSON.parse(await fsp.readFile(cachePath, "utf8"));
    if (parsed?.cacheVersion !== CACHE_VERSION || parsed?.usageKind !== USAGE_KIND) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeUsageCache(cachePath, usage) {
  if (!cachePath) return;
  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, `${JSON.stringify(usage, null, 2)}\n`, "utf8");
  } catch {
    // Cache persistence is optional; the in-memory result remains usable.
  }
}

function getDefaultSessionsDir() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function getDefaultCachePath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "ProjectLauncherWorkbench", "codex-usage-cache.json");
}

function parseDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

module.exports = {
  createCodexUsageService,
  findRecentSessionFiles,
  getUsageRefreshIntervalMs,
  normalizeRateLimitEvent,
  parseLatestRateLimit,
  readLatestRateLimitFromFile,
  scanCodexUsage
};
