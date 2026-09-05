const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createCodexUsageService,
  getUsageRefreshIntervalMs,
  normalizeAppServerRateLimits,
  parseLatestRateLimit,
  readLatestRateLimitFromFile
} = require("../server/codex-usage");

function rateLimitEvent(overrides = {}) {
  return {
    timestamp: overrides.timestamp || "2026-07-15T13:55:27.966Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: overrides.limitId || "codex",
        limit_name: overrides.limitName ?? null,
        primary: overrides.primary || {
          used_percent: 40,
          window_minutes: 300,
          resets_at: 1784720000
        },
        secondary: overrides.secondary === undefined ? {
          used_percent: overrides.usedPercent ?? 12.5,
          window_minutes: 10080,
          resets_at: 1784728513
        } : overrides.secondary
      }
    }
  };
}

test("canonical Codex weekly limit is selected and Spark is ignored", () => {
  const codex = rateLimitEvent({ usedPercent: 12.5 });
  const spark = rateLimitEvent({
    timestamp: "2026-07-15T14:00:00.000Z",
    limitId: "codex_bengalfox",
    limitName: "GPT-5.3-Codex-Spark",
    primary: {
      used_percent: 99,
      window_minutes: 10080,
      resets_at: 1784730578
    },
    secondary: null
  });
  const result = parseLatestRateLimit([
    JSON.stringify(codex),
    "not-json",
    JSON.stringify(spark)
  ].join("\n"));

  assert.equal(result.limitId, "codex");
  assert.equal(result.limitName, "Codex");
  assert.equal(result.usageKind, "codex_weekly");
  assert.equal(result.usedPercent, 12.5);
  assert.equal(result.remainingPercent, 87.5);
  assert.equal(result.windowMinutes, 10080);
  assert.equal(result.resetsAt, "2026-07-22T13:55:13.000Z");
});

test("app server response selects the canonical bucket and exposes remaining quota", () => {
  const result = normalizeAppServerRateLimits({
    rateLimits: {
      limitId: "codex_bengalfox",
      primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 1784730578 }
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 1784730578 }
      },
      codex: {
        limitId: "codex",
        primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1784780159 }
      }
    },
    rateLimitResetCredits: { availableCount: 5 }
  }, { observedAt: "2026-07-16T13:00:00.000Z" });

  assert.equal(result.limitId, "codex");
  assert.equal(result.usedPercent, 10);
  assert.equal(result.remainingPercent, 90);
  assert.equal(result.resetsAt, "2026-07-23T04:15:59.000Z");
  assert.equal(result.resetCredits, 5);
  assert.equal(result.source, "app_server");
});

test("session reader finds an event near the end of a large JSONL file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-"));
  const filePath = path.join(directory, "session.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const prefix = `${JSON.stringify({ type: "noise", value: "x".repeat(300000) })}\n`;
  await fs.writeFile(filePath, prefix + JSON.stringify(rateLimitEvent()), "utf8");
  const result = await readLatestRateLimitFromFile(filePath);

  assert.equal(result.usedPercent, 12.5);
});

test("refresh intervals decrease as the weekly quota fills", () => {
  assert.equal(getUsageRefreshIntervalMs(20), 30 * 60 * 1000);
  assert.equal(getUsageRefreshIntervalMs(60), 15 * 60 * 1000);
  assert.equal(getUsageRefreshIntervalMs(85), 5 * 60 * 1000);
  assert.equal(getUsageRefreshIntervalMs(98), 2 * 60 * 1000);
});

test("usage service reuses fresh data until its dynamic refresh time", async () => {
  let currentTime = Date.parse("2026-07-15T14:00:00.000Z");
  let scans = 0;
  const service = createCodexUsageService({
    cachePath: null,
    now: () => currentTime,
    scan: async () => {
      scans += 1;
      return {
        ...parseLatestRateLimit(JSON.stringify(rateLimitEvent({ usedPercent: 20 }))),
        resetsAt: "2026-07-30T00:00:00.000Z"
      };
    }
  });

  const first = await service.getUsage();
  const second = await service.getUsage();
  assert.equal(scans, 1);
  assert.equal(second.cached, true);

  currentTime = Date.parse(first.nextRefreshAt) + 1;
  await service.getUsage();
  assert.equal(scans, 2);
});

test("usage service preserves the last value when a refresh fails", async () => {
  let currentTime = Date.parse("2026-07-15T14:00:00.000Z");
  let fail = false;
  const service = createCodexUsageService({
    cachePath: null,
    now: () => currentTime,
    scan: async () => {
      if (fail) throw new Error("session unavailable");
      return {
        ...parseLatestRateLimit(JSON.stringify(rateLimitEvent({ usedPercent: 82 }))),
        resetsAt: "2026-07-30T00:00:00.000Z"
      };
    }
  });

  await service.getUsage();
  fail = true;
  currentTime += 31 * 60 * 1000;
  const stale = await service.getUsage();

  assert.equal(stale.available, true);
  assert.equal(stale.usedPercent, 82);
  assert.equal(stale.stale, true);
  assert.match(stale.message, /session unavailable/);
});

test("old session observations are not presented as current quota", async () => {
  const service = createCodexUsageService({
    cachePath: null,
    now: () => Date.parse("2026-07-16T14:00:00.000Z"),
    scan: async () => ({
      ...parseLatestRateLimit(JSON.stringify(rateLimitEvent({
        timestamp: "2026-07-11T17:33:20.172Z",
        usedPercent: 17
      }))),
      resetsAt: "2026-07-18T07:37:55.000Z"
    })
  });

  const result = await service.getUsage();
  assert.equal(result.available, false);
  assert.equal(result.stale, true);
  assert.match(result.message, /\u6570\u636e\u5df2\u8fc7\u671f/);
});


test("legacy model-specific cache is ignored", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-cache-"));
  const cachePath = path.join(directory, "usage.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await fs.writeFile(cachePath, JSON.stringify({
    cacheVersion: 1,
    available: true,
    limitId: "codex_bengalfox",
    limitName: "GPT-5.3-Codex-Spark",
    usedPercent: 99,
    nextRefreshAt: "2026-08-01T00:00:00.000Z"
  }), "utf8");

  let scans = 0;
  const service = createCodexUsageService({
    cachePath,
    now: () => Date.parse("2026-07-15T14:00:00.000Z"),
    scan: async () => {
      scans += 1;
      return parseLatestRateLimit(JSON.stringify(rateLimitEvent({ usedPercent: 17 })));
    }
  });

  const result = await service.getUsage();
  assert.equal(scans, 1);
  assert.equal(result.limitId, "codex");
  assert.equal(result.usedPercent, 17);
});
