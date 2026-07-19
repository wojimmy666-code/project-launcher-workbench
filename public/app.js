const state = {
  projects: [],
  categories: [],
  statuses: {},
  systemHealth: {
    server: { state: "checking", label: "检查中" },
    network: { state: "checking", label: "检查中" },
    external: { state: "checking", label: "检查中" }
  },
  codexUsage: { available: false, loading: true, stale: true },
  selectedCategory: "all",
  search: "",
  statusFilter: "all",
  typeFilter: "all",
  drawerMode: "create",
  editingId: null,
  draggingId: null
};

const pendingProjectActions = new Map();
const pendingProjectAdoptions = new Set();
const recentProjectActionCompletions = new Map();
const appliedStatusSequences = new Map();
let statusRequestSequence = 0;
let statusRefreshPending = null;

const els = {
  categoryNav: document.querySelector("#categoryNav"),
  manageCategoriesButton: document.querySelector("#manageCategoriesButton"),
  projectRows: document.querySelector("#projectRows"),
  searchInput: document.querySelector("#searchInput"),
  statusFilter: document.querySelector("#statusFilter"),
  typeFilter: document.querySelector("#typeFilter"),
  newProjectButton: document.querySelector("#newProjectButton"),
  summaryText: document.querySelector("#summaryText"),
  systemHealth: document.querySelector("#systemHealth"),
  codexUsage: document.querySelector("#codexUsage"),
  codexUsageLabel: document.querySelector("#codexUsageLabel"),
  codexUsageMeterFill: document.querySelector("#codexUsageMeterFill"),
  codexUsageValue: document.querySelector("#codexUsageValue"),
  codexUsageReset: document.querySelector("#codexUsageReset"),
  drawerBackdrop: document.querySelector("#drawerBackdrop"),
  projectDrawer: document.querySelector("#projectDrawer"),
  projectForm: document.querySelector("#projectForm"),
  drawerTitle: document.querySelector("#drawerTitle"),
  drawerClose: document.querySelector("#drawerClose"),
  drawerCancel: document.querySelector("#drawerCancel"),
  drawerErrors: document.querySelector("#drawerErrors"),
  deleteInDrawerButton: document.querySelector("#deleteInDrawerButton"),
  openDrawerLogButton: document.querySelector("#openDrawerLogButton"),
  openGithubButton: document.querySelector("#openGithubButton"),
  drawerTabs: document.querySelector("#drawerTabs"),
  launchConfigSection: document.querySelector("#launchConfigSection"),
  projectSaveButton: document.querySelector("#projectSaveButton"),
  projectTypeInput: document.querySelector("#projectForm select[name=\"type\"]"),
  projectCategoryInput: document.querySelector("#projectForm select[name=\"category\"]"),
  urlPortWarning: document.querySelector("#urlPortWarning"),
  categoryModal: document.querySelector("#categoryModal"),
  categoryModalClose: document.querySelector("#categoryModalClose"),
  categoryList: document.querySelector("#categoryList"),
  categoryForm: document.querySelector("#categoryForm"),
  categoryCreateButton: document.querySelector("#categoryCreateButton"),
  modal: document.querySelector("#modal"),
  modalTitle: document.querySelector("#modalTitle"),
  modalBody: document.querySelector("#modalBody"),
  modalClose: document.querySelector("#modalClose"),
  toast: document.querySelector("#toast"),
  footerServiceDot: document.querySelector("#footerServiceDot"),
  footerServiceState: document.querySelector("#footerServiceState"),
  footerProjectCount: document.querySelector("#footerProjectCount"),
  footerCheckedAt: document.querySelector("#footerCheckedAt")
};

const statusText = {
  running: "运行中",
  starting: "启动中",
  stopping: "停止中",
  stopped: "未启动",
  conflict: "端口冲突",
  error: "异常",
  unknown: "未知"
};

const projectTypes = ["exe", "bat", "cmd", "url", "folder", "file"];
const typeLabels = {
  exe: "\u8f6f\u4ef6",
  bat: "\u6279\u5904\u7406",
  cmd: "\u547d\u4ee4",
  url: "\u7f51\u9875",
  folder: "\u6587\u4ef6\u5939",
  file: "\u6587\u4ef6"
};
const runnableTypes = new Set(["exe", "bat", "cmd"]);
const STATUS_POLL_INTERVAL_MS = 5000;
const HEALTH_POLL_INTERVAL_MS = 15000;
const BROWSER_EXTERNAL_PROBE_TIMEOUT_MS = 4000;
const BROWSER_EXTERNAL_PROBE_TTL_MS = 30000;
const BROWSER_EXTERNAL_FAILURE_TTL_MS = 5000;
const PROJECT_ACTION_MIN_FEEDBACK_MS = 180;
const PROJECT_ACTION_ROLLBACK_MS = 160;
const PROJECT_START_CONFIRM_TIMEOUT_MS = 32000;
const PROJECT_START_CONFIRM_POLL_MS = 250;
const PROJECT_STOP_CONFIRM_TIMEOUT_MS = 3000;
const PROJECT_STOP_CONFIRM_POLL_MS = 150;
const CODEX_FOCUS_STALE_MS = 30 * 60 * 1000;
const CODEX_HIDDEN_RETRY_MS = 30 * 60 * 1000;
const CODEX_AFTER_LAUNCH_REFRESH_MS = 10 * 60 * 1000;
let codexUsageTimer = null;
let codexUsageRefreshPending = false;
let codexDesktopLaunchPending = false;
let browserExternalProbeCache = null;
let browserExternalProbePending = null;
const HEALTH_ITEMS = [
  { key: "server", name: "后台" },
  { key: "network", name: "网络" },
  { key: "external", name: "外网" }
];
const HEALTH_LABELS = {
  ok: "正常",
  checking: "检查中",
  degraded: "受限",
  down: "不可达",
  unknown: "未知"
};
const CATEGORY_IDS = {
  all: "all",
  running: "running",
  favorite: "favorite",
  uncategorized: "uncategorized"
};
const UNCATEGORIZED_CATEGORY_NAME = "\u672a\u5206\u7c7b";
const FIXED_CATEGORY_ITEMS = [
  { id: CATEGORY_IDS.all, name: "\u5168\u90e8\u9879\u76ee" },
  { id: CATEGORY_IDS.running, name: "\u6b63\u5728\u8fd0\u884c" },
  { id: CATEGORY_IDS.favorite, name: "\u6536\u85cf" }
];

const tableIcons = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  drag: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>'
};

init().catch((error) => showToast(error.message || "初始化失败"));

async function init() {
  bindEvents();
  await loadProjects();
  await Promise.allSettled([
    refreshDashboardStatus({ silent: true }),
    refreshCodexUsage({ silent: true })
  ]);
  startStatusPolling();
}

function bindEvents() {
  els.searchInput.addEventListener("input", () => {
    state.search = els.searchInput.value.trim().toLowerCase();
    render();
  });

  els.statusFilter.addEventListener("change", () => {
    state.statusFilter = els.statusFilter.value;
    render();
  });

  els.typeFilter.addEventListener("change", () => {
    state.typeFilter = els.typeFilter.value;
    render();
  });

  els.newProjectButton.addEventListener("click", () => openCreateDrawer());
  els.manageCategoriesButton.addEventListener("click", () => openCategoryModal());
  els.drawerClose.addEventListener("click", () => closeProjectDrawer());
  els.drawerCancel.addEventListener("click", () => closeProjectDrawer());
  els.drawerBackdrop.addEventListener("click", () => closeProjectDrawer());
  els.projectTypeInput.addEventListener("change", () => syncTypeFields());
  els.projectForm.elements.githubUrl.addEventListener("input", () => syncGithubLink());
  els.projectForm.elements.url.addEventListener("input", () => syncUrlPortWarning());
  els.projectForm.elements.port.addEventListener("input", () => syncUrlPortWarning());
  els.drawerTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-drawer-tab]");
    if (!tab || tab.hidden) return;
    activateDrawerTab(tab.dataset.drawerTab);
  });
  els.drawerTabs.addEventListener("keydown", (event) => handleDrawerTabKeydown(event));
  els.projectForm.addEventListener("submit", (event) => submitProjectForm(event));
  els.deleteInDrawerButton.addEventListener("click", () => {
    if (state.editingId) deleteProject(state.editingId);
  });
  els.openDrawerLogButton.addEventListener("click", () => openDrawerLogs());
  els.modalClose.addEventListener("click", () => els.modal.close());
  els.categoryModalClose.addEventListener("click", () => els.categoryModal.close());
  els.categoryForm.addEventListener("submit", (event) => submitCategoryForm(event));
  els.codexUsage.addEventListener("click", () => openCodexDesktopFromUsage());
  window.addEventListener("focus", refreshCodexUsageWhenStale);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshCodexUsageWhenStale();
  });
  document.addEventListener("keydown", handleGlobalKeyboardShortcuts);
}

function handleGlobalKeyboardShortcuts(event) {
  const commandKey = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (commandKey && !event.altKey && key === "k") {
    event.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
    return;
  }

  if (commandKey && !event.altKey && key === "n") {
    event.preventDefault();
    openCreateDrawer();
    return;
  }

  if (event.key === "Escape" && els.projectDrawer.getAttribute("aria-hidden") === "false") {
    event.preventDefault();
    closeProjectDrawer();
  }
}

async function loadProjects() {
  const data = await api("/api/projects");
  state.projects = data.projects || [];
  state.categories = data.categories || [];
  buildTypeOptions();
  buildFormOptions();
  render();
}

function refreshStatuses(options = {}) {
  if (statusRefreshPending) return statusRefreshPending;

  const request = refreshStatusesOnce(options).finally(() => {
    if (statusRefreshPending === request) statusRefreshPending = null;
  });
  statusRefreshPending = request;
  return request;
}

async function refreshStatusesOnce(options = {}) {
  const requestSequence = ++statusRequestSequence;
  const requestedAt = Date.now();
  const data = await api("/api/status/all");
  const nextStatuses = { ...state.statuses };

  for (const [projectId, nextStatus] of Object.entries(data.statuses || {})) {
    const lastAppliedSequence = appliedStatusSequences.get(projectId) || 0;
    const completedAt = recentProjectActionCompletions.get(projectId) || 0;
    if (
      pendingProjectActions.has(projectId)
      || pendingProjectAdoptions.has(projectId)
      || requestedAt <= completedAt
      || requestSequence < lastAppliedSequence
    ) {
      continue;
    }
    nextStatuses[projectId] = nextStatus;
    appliedStatusSequences.set(projectId, requestSequence);
  }

  for (const [projectId, completedAt] of recentProjectActionCompletions) {
    if (Date.now() - completedAt > STATUS_POLL_INTERVAL_MS * 2) {
      recentProjectActionCompletions.delete(projectId);
    }
  }

  state.statuses = nextStatuses;
  render();
  if (!options.silent) showToast("状态检查完成");
}

async function refreshDashboardStatus(options = {}) {
  const results = await Promise.allSettled([
    refreshStatuses({ silent: true, background: true }),
    refreshSystemHealth({ background: true })
  ]);
  if (!options.silent) {
    const failed = results.some((result) => result.status === "rejected");
    showToast(failed ? "部分状态检查失败" : "状态检查完成");
  }
}

async function refreshSystemHealth(options = {}) {
  if (!options.background) {
    state.systemHealth = markSystemHealthChecking(state.systemHealth);
    renderSystemHealth();
  }

  try {
    const data = await api("/api/system/health");
    state.systemHealth = await addBrowserExternalFallback(normalizeSystemHealth(data));
    renderSystemHealth();
  } catch (error) {
    const checkedAt = new Date().toISOString();
    state.systemHealth = {
      server: { state: "down", label: "无响应", message: error.message || "请求失败", checkedAt },
      network: { state: "unknown", label: "未知", checkedAt },
      external: { state: "unknown", label: "未知", checkedAt },
      checkedAt
    };
    renderSystemHealth();
    throw error;
  }
}

function startStatusPolling() {
  window.setInterval(() => {
    refreshStatuses({ silent: true, background: true }).catch(() => {});
  }, STATUS_POLL_INTERVAL_MS);

  window.setInterval(() => {
    refreshSystemHealth({ background: true }).catch(() => {});
  }, HEALTH_POLL_INTERVAL_MS);
}

function buildTypeOptions() {
  const current = els.typeFilter.value;
  const types = [...new Set([...projectTypes, ...state.projects.map((project) => project.type).filter(Boolean)])].sort();
  els.typeFilter.innerHTML = `<option value="all">\u5168\u90e8\u7c7b\u578b</option>${types.map((type) => (
    `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`
  )).join("")}`;
  els.typeFilter.value = types.includes(current) ? current : "all";
  state.typeFilter = els.typeFilter.value;
}

function render() {
  renderCategories();
  renderSummary();
  renderSystemHealth();
  renderCodexUsage();
  renderTable();
}

function renderSystemHealth() {
  const health = state.systemHealth || {};
  els.systemHealth.innerHTML = HEALTH_ITEMS.map((item) => renderHealthPill(item, health[item.key], health.checkedAt)).join("");
  renderDesktopStatus();
}

function renderDesktopStatus() {
  const server = state.systemHealth?.server || { state: "checking" };
  const serverState = normalizeHealthState(server.state || "checking");
  const serviceLabels = {
    ok: "本地服务正常",
    checking: "本地服务检查中",
    degraded: "本地服务受限",
    down: "本地服务不可用",
    unknown: "本地服务状态未知"
  };
  const visibleCount = visibleProjects().length;

  els.footerServiceDot.className = "statusbar-dot statusbar-" + serverState;
  els.footerServiceState.textContent = serviceLabels[serverState] || serviceLabels.unknown;
  els.footerProjectCount.textContent = visibleCount + " 个可见项目";
  els.footerCheckedAt.textContent = state.systemHealth?.checkedAt
    ? "更新于 " + formatHealthTime(state.systemHealth.checkedAt)
    : "等待状态检查";
}

function renderHealthPill(item, info = {}, fallbackCheckedAt = null) {
  const healthState = normalizeHealthState(info.state);
  const label = info.label || HEALTH_LABELS[healthState] || healthState;
  const title = formatHealthTitle(item.name, info, label, fallbackCheckedAt);
  return `
    <span class="health-pill health-${escapeHtml(healthState)}" title="${escapeHtml(title)}">
      <span class="health-dot" aria-hidden="true"></span>
      <span class="health-name">${escapeHtml(item.name)}</span>
      <span class="health-value">${escapeHtml(label)}</span>
    </span>`;
}

function normalizeSystemHealth(data = {}) {
  const checkedAt = data.checkedAt || new Date().toISOString();
  return {
    server: normalizeHealthItem(data.server, "unknown", "未知", checkedAt),
    network: normalizeHealthItem(data.network, "unknown", "未知", checkedAt),
    external: normalizeHealthItem(data.external, "unknown", "未知", checkedAt),
    checkedAt
  };
}

function normalizeHealthItem(info = {}, fallbackState, fallbackLabel, checkedAt) {
  const healthState = normalizeHealthState(info.state || fallbackState);
  return {
    ...info,
    state: healthState,
    label: info.label || HEALTH_LABELS[healthState] || fallbackLabel,
    checkedAt: info.checkedAt || checkedAt
  };
}

function normalizeHealthState(value) {
  return ["ok", "checking", "degraded", "down", "unknown"].includes(value) ? value : "unknown";
}

function markSystemHealthChecking(current = {}) {
  return {
    ...current,
    server: { ...(current.server || {}), state: "checking", label: "检查中" },
    network: { ...(current.network || {}), state: "checking", label: "检查中" },
    external: { ...(current.external || {}), state: "checking", label: "检查中" }
  };
}

function formatHealthTitle(name, info = {}, label, fallbackCheckedAt = null) {
  const lines = [`${name}${label ? ` · ${label}` : ""}`];
  if (info.target) lines.push(`检测目标：${info.target}`);
  if (info.host && info.port) lines.push(`监听地址：${info.host}:${info.port}`);
  if (info.viaLabel) lines.push(`访问方式：${info.viaLabel}`);
  if (info.proxyEndpoint) lines.push(`代理地址：${info.proxyEndpoint}`);
  if (info.proxyPid) lines.push(`代理进程：${info.proxyProcess ? `${info.proxyProcess} · ` : ""}PID ${info.proxyPid}`);
  if (info.backendState) lines.push(`后台检测：${info.backendLabel || info.backendState}`);
  if (Number.isFinite(Number(info.latencyMs))) lines.push(`响应：${Math.round(Number(info.latencyMs))}ms`);
  if (info.statusCode) lines.push(`状态码：${info.statusCode}`);
  if (info.message) lines.push(`说明：${info.message}`);
  const checkedAt = info.checkedAt || fallbackCheckedAt;
  if (checkedAt) lines.push(`检查时间：${formatHealthTime(checkedAt)}`);
  return lines.join("\n");
}

async function addBrowserExternalFallback(health) {
  const external = health.external || {};
  if (!["down", "degraded"].includes(external.state)) return health;

  const browser = await probeBrowserExternal(external.browserProbeUrl || external.target);
  if (!browser.ok) return health;

  return {
    ...health,
    external: {
      ...external,
      state: "ok",
      label: "浏览器可用",
      target: browser.target,
      latencyMs: browser.latencyMs,
      via: "browser",
      viaLabel: "浏览器网络",
      backendState: external.state,
      backendLabel: external.label,
      message: `浏览器可访问外网；后台检测：${external.message || external.label || external.state}`,
      checkedAt: new Date().toISOString()
    }
  };
}

function probeBrowserExternal(target) {
  const url = String(target || "").trim();
  if (!/^https?:\/\//i.test(url)) return Promise.resolve({ ok: false, message: "没有浏览器检测目标" });
  const now = Date.now();
  const cacheTtl = browserExternalProbeCache?.ok ? BROWSER_EXTERNAL_PROBE_TTL_MS : BROWSER_EXTERNAL_FAILURE_TTL_MS;
  if (browserExternalProbeCache?.target === url && now - browserExternalProbeCache.checkedAt < cacheTtl) {
    return Promise.resolve(browserExternalProbeCache);
  }
  if (browserExternalProbePending?.target === url) return browserExternalProbePending.promise;

  const promise = (async () => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), BROWSER_EXTERNAL_PROBE_TIMEOUT_MS);
    try {
      const separator = url.includes("?") ? "&" : "?";
      await fetch(`${url}${separator}_workbench_probe=${Date.now()}`, {
        method: "GET",
        mode: "no-cors",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });
      const result = { ok: true, target: url, latencyMs: Date.now() - startedAt, checkedAt: Date.now() };
      browserExternalProbeCache = result;
      return result;
    } catch (error) {
      const result = { ok: false, target: url, message: error.message || "浏览器检测失败", checkedAt: Date.now() };
      browserExternalProbeCache = result;
      return result;
    } finally {
      window.clearTimeout(timer);
      browserExternalProbePending = null;
    }
  })();
  browserExternalProbePending = { target: url, promise };
  return promise;
}
function formatHealthTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return formatDate(date);
}

async function openCodexDesktopFromUsage() {
  if (codexDesktopLaunchPending) return;
  codexDesktopLaunchPending = true;
  renderCodexUsage();

  try {
    const data = await api("/api/codex/open", { method: "POST" });
    showToast(data.message || "已打开 ChatGPT/Codex 桌面程序");
    scheduleCodexUsageRefresh(CODEX_AFTER_LAUNCH_REFRESH_MS);
  } catch (error) {
    showToast(error.message || "打开 ChatGPT/Codex 桌面程序失败");
  } finally {
    codexDesktopLaunchPending = false;
    renderCodexUsage();
  }
}

async function refreshCodexUsage(options = {}) {
  if (codexUsageRefreshPending) return;
  codexUsageRefreshPending = true;
  state.codexUsage = { ...state.codexUsage, loading: true };
  renderCodexUsage();

  try {
    const data = await api(`/api/codex/usage${options.force ? "?force=1" : ""}`);
    state.codexUsage = { ...data, loading: false };
    renderCodexUsage();
    scheduleCodexUsageRefresh();
  } catch (error) {
    state.codexUsage = {
      ...state.codexUsage,
      loading: false,
      stale: true,
      message: error.message || "Codex 用量读取失败"
    };
    renderCodexUsage();
    scheduleCodexUsageRefresh(CODEX_HIDDEN_RETRY_MS);
    if (!options.silent) showToast(state.codexUsage.message);
  } finally {
    codexUsageRefreshPending = false;
    renderCodexUsage();
  }
}

function refreshCodexUsageWhenStale() {
  const checkedAt = Date.parse(state.codexUsage?.checkedAt || "");
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt >= CODEX_FOCUS_STALE_MS) {
    refreshCodexUsage({ silent: true, force: true }).catch(() => {});
  }
}

function scheduleCodexUsageRefresh(delayOverride = null) {
  window.clearTimeout(codexUsageTimer);
  const nextRefreshAt = Date.parse(state.codexUsage?.nextRefreshAt || "");
  const requestedDelay = Number.isFinite(delayOverride)
    ? delayOverride
    : (Number.isFinite(nextRefreshAt) ? nextRefreshAt - Date.now() : CODEX_HIDDEN_RETRY_MS);
  const delay = Math.max(60 * 1000, requestedDelay);

  codexUsageTimer = window.setTimeout(() => {
    if (document.hidden) {
      scheduleCodexUsageRefresh(CODEX_HIDDEN_RETRY_MS);
      return;
    }
    refreshCodexUsage({ silent: true }).catch(() => {});
  }, delay);
}

function renderCodexUsage() {
  if (!els.codexUsage) return;
  const usage = state.codexUsage || {};
  const available = usage.available === true;
  const usedPercent = available ? Math.min(100, Math.max(0, Number(usage.usedPercent) || 0)) : 0;
  const remainingValue = Number(usage.remainingPercent);
  const remainingPercent = available
    ? Math.min(100, Math.max(0, Number.isFinite(remainingValue) ? remainingValue : 100 - usedPercent))
    : 0;
  const level = !available
    ? "unavailable"
    : (remainingPercent <= 5 ? "critical" : (remainingPercent <= 20 ? "warning" : "normal"));
  const classes = ["codex-usage", "codex-usage-" + level];
  if (usage.loading) classes.push("codex-usage-loading");
  if (usage.stale) classes.push("codex-usage-stale");
  if (codexDesktopLaunchPending) classes.push("codex-usage-opening");

  els.codexUsage.className = classes.join(" ");
  els.codexUsage.disabled = codexDesktopLaunchPending;
  els.codexUsage.setAttribute("aria-busy", codexDesktopLaunchPending ? "true" : "false");
  els.codexUsageLabel.textContent = codexDesktopLaunchPending ? "正在打开 ChatGPT" : "Codex 剩余额度";
  els.codexUsageMeterFill.style.width = remainingPercent + "%";
  els.codexUsageValue.textContent = available ? formatCodexPercent(remainingPercent) : "--";
  els.codexUsageReset.textContent = available && usage.resetsAt
    ? formatCodexResetTime(usage.resetsAt) + " \u91cd\u7f6e"
    : (usage.loading ? "\u8bfb\u53d6\u4e2d" : "\u672a\u68c0\u6d4b\u5230\u7528\u91cf");

  const title = formatCodexUsageTitle(usage);
  els.codexUsage.title = `${title}\n点击打开 ChatGPT/Codex 桌面程序`;
  els.codexUsage.setAttribute(
    "aria-label",
    codexDesktopLaunchPending
      ? "正在打开 ChatGPT/Codex 桌面程序"
      : `打开 ChatGPT/Codex 桌面程序。${title.replace(/\n/g, "\uff0c")}`
  );
}

function formatCodexPercent(value) {
  if (value > 0 && value < 0.1) return "<0.1%";
  return (Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)) + "%";
}

function formatCodexResetTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatCodexUsageTitle(usage) {
  if (!usage?.available) {
    return usage?.message || "\u672a\u68c0\u6d4b\u5230 Codex \u5468\u989d\u5ea6\u6570\u636e";
  }

  const usedPercent = Math.min(100, Math.max(0, Number(usage.usedPercent) || 0));
  const remainingValue = Number(usage.remainingPercent);
  const remainingPercent = Math.min(
    100,
    Math.max(0, Number.isFinite(remainingValue) ? remainingValue : 100 - usedPercent)
  );
  const lines = ["Codex \u5468\u989d\u5ea6\u5269\u4f59\uff1a" + formatCodexPercent(remainingPercent)];
  lines.push("\u5df2\u7528\uff1a" + formatCodexPercent(usedPercent));
  if (usage.resetsAt) lines.push("\u91cd\u7f6e\u65f6\u95f4\uff1a" + formatDate(usage.resetsAt));
  if (Number.isFinite(Number(usage.resetCredits))) {
    lines.push("\u53ef\u91cd\u7f6e\u6b21\u6570\uff1a" + Number(usage.resetCredits));
  }
  if (usage.observedAt) lines.push("\u6570\u636e\u65f6\u95f4\uff1a" + formatDate(usage.observedAt));
  if (usage.stale) lines.push("\u5f53\u524d\u663e\u793a\u4e0a\u4e00\u6b21\u7f13\u5b58\u6570\u636e");
  return lines.join("\n");
}

function renderCategories() {
  ensureSelectedCategory();
  const categories = getCategories();
  els.categoryNav.innerHTML = categories.map((item) => `
    <button class="nav-button ${item.id === state.selectedCategory ? "active" : ""}" type="button" data-category-id="${escapeHtml(item.id)}">
      <span>${escapeHtml(item.name)}</span>
      <span class="nav-count">${item.count}</span>
    </button>
  `).join("");

  els.categoryNav.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCategory = button.dataset.categoryId;
      render();
    });
  });
}

function getCategories() {
  const fixed = FIXED_CATEGORY_ITEMS.map((item) => ({
    ...item,
    fixed: true,
    count: countSystemCategory(item.id)
  }));

  const custom = getCustomCategories().map((category) => ({
    ...category,
    fixed: false,
    count: countProjectsInCategory(category.id)
  }));

  return [
    ...fixed,
    ...custom,
    {
      id: CATEGORY_IDS.uncategorized,
      name: UNCATEGORIZED_CATEGORY_NAME,
      fixed: true,
      count: countProjectsInCategory(CATEGORY_IDS.uncategorized)
    }
  ];
}

function getCustomCategories() {
  return [...state.categories].sort((a, b) => {
    const orderDelta = Number(a.order || 0) - Number(b.order || 0);
    if (orderDelta) return orderDelta;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
  });
}

function countSystemCategory(id) {
  if (id === CATEGORY_IDS.all) return state.projects.length;
  if (id === CATEGORY_IDS.running) return state.projects.filter((project) => statusOf(project).state === "running").length;
  if (id === CATEGORY_IDS.favorite) return state.projects.filter((project) => project.favorite).length;
  return 0;
}

function countProjectsInCategory(categoryId) {
  return state.projects.filter((project) => normalizeCategoryId(project.category) === categoryId).length;
}

function normalizeCategoryId(value) {
  const raw = String(value || "").trim();
  return raw && raw !== UNCATEGORIZED_CATEGORY_NAME ? raw : CATEGORY_IDS.uncategorized;
}

function categoryLabel(categoryId) {
  const normalized = normalizeCategoryId(categoryId);
  const fixed = FIXED_CATEGORY_ITEMS.find((item) => item.id === normalized);
  if (fixed) return fixed.name;
  if (normalized === CATEGORY_IDS.uncategorized) return UNCATEGORIZED_CATEGORY_NAME;
  return state.categories.find((category) => category.id === normalized)?.name || normalized;
}

function ensureSelectedCategory() {
  const validIds = new Set([
    CATEGORY_IDS.all,
    CATEGORY_IDS.running,
    CATEGORY_IDS.favorite,
    CATEGORY_IDS.uncategorized,
    ...state.categories.map((category) => category.id)
  ]);
  if (!validIds.has(state.selectedCategory)) {
    state.selectedCategory = CATEGORY_IDS.all;
  }
}

function renderSummary() {
  const total = state.projects.length;
  const running = state.projects.filter((project) => statusOf(project).state === "running").length;
  const error = state.projects.filter((project) => ["error", "conflict"].includes(statusOf(project).state)).length;
  els.summaryText.textContent = `${total} 个项目，${running} 个运行中，${error} 个异常`;
}

function renderTable() {
  const projects = visibleProjects();

  if (!projects.length) {
    els.projectRows.innerHTML = `<tr><td colspan="7" class="empty-cell">没有匹配的项目</td></tr>`;
    return;
  }

  const canReorder = projects.length > 1;

  els.projectRows.innerHTML = projects.map((project) => {
    const status = statusOf(project);
    const target = project.command || project.path || project.url || "-";
    const runtimePids = Array.isArray(status.runtime?.pids) ? status.runtime.pids.map(Number) : [];
    const runtimePidSet = new Set(runtimePids);
    const externalPids = Array.isArray(status.externalPids) ? status.externalPids.map(Number).filter((pid) => !runtimePidSet.has(pid)) : [];
    const conflictPids = Array.isArray(status.conflictPids) ? status.conflictPids.map(Number) : [];
    const conflicts = Array.isArray(status.conflicts) ? status.conflicts : [];
    const selfManaged = status.selfManaged || status.management === "self";
    const selfPids = selfManaged
      ? (status.ownedPortPids || []).map(Number).filter((pid) => !runtimePidSet.has(pid))
      : [];
    const pidTags = [
      ...runtimePids.map((pid) => `<span class="pid-tag">PID ${escapeHtml(pid)}</span>`),
      ...selfPids.map((pid) => `<span class="pid-tag self-pid">当前 PID ${escapeHtml(pid)}</span>`),
      ...externalPids.map((pid) => `<span class="pid-tag external-pid">\u5916\u90e8 PID ${escapeHtml(pid)}</span>`),
      ...conflictPids.map((pid) => `<span class="pid-tag conflict-pid">\u51b2\u7a81 PID ${escapeHtml(pid)}</span>`)
    ];
    const pidLine = pidTags.length ? `<div class="pid-tags">${pidTags.join("")}</div>` : "";
    const displayUrl = project.url ? `<a class="url-link" href="${escapeHtml(project.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(project.url)}</a>` : "-";
    const resourceControl = renderResourceCell(status.memory);
    const pending = pendingProjectActions.get(project.id);
    const adoptionPending = pendingProjectAdoptions.has(project.id);
    const canRun = runnableTypes.has(project.type);
    const actualIsRunning = status.state === "running" || status.state === "starting";
    const statusIsStopping = status.state === "stopping";
    const statusIsConflict = status.state === "conflict";
    const management = status.management
      || (status.runtime?.running ? (status.runtime.source === "adopted" ? "adopted" : "managed") : (externalPids.length ? "external" : null));
    const externalOnly = management === "external" && actualIsRunning;
    const managementLabels = {
      managed: "管理台启动",
      external: "外部启动",
      mixed: "混合运行",
      adopted: "已接管",
      self: "当前管理台"
    };
    const managedInstanceCount = Number(status.runtime?.runningCount || 0);
    const showManagedInstanceCount = managedInstanceCount > 1
      || (project.allowMultiple && managedInstanceCount > 0);
    const managementLabel = management === "managed" && showManagedInstanceCount
      ? `管理台启动 · ${managedInstanceCount} 个实例`
      : management === "mixed" && managedInstanceCount > 0
        ? `混合运行 · ${managedInstanceCount} 个管理实例`
        : managementLabels[management];
    const managementBadge = actualIsRunning && managementLabel
      ? `<span class="management-badge management-${escapeHtml(management)}">${escapeHtml(managementLabel)}</span>`
      : "";
    const displayIsRunning = pending ? pending.targetState === "running" : actualIsRunning;
    const displayStatusState = pending?.statusState || status.state;
    const displayStatusMessage = pending
      ? (pending.action === "start" ? "正在启动项目" : "正在停止项目")
      : (adoptionPending ? "正在接管外部进程" : (status.message || ""));
    const toggleAction = pending?.action || (statusIsStopping ? "stop" : (displayIsRunning ? "stop" : "start"));
    const toggleLabel = pending
      ? (pending.action === "start" ? "启动中" : "停止中")
      : (externalOnly ? "外部运行" : (statusIsConflict ? "端口冲突" : (statusIsStopping ? "停止中" : (displayIsRunning ? "停止" : "启动"))));
    const toggleClass = externalOnly ? "switch-external" : (displayIsRunning ? "switch-on" : "switch-off");
    const switchPendingClass = pending
      ? ` switch-pending switch-pending-${pending.action}`
      : (statusIsStopping ? " switch-pending switch-pending-stop" : "");
    const startPending = pending?.action === "start";
    const stopPending = pending?.action === "stop" || (!pending && statusIsStopping);
    const controlsDisabled = !canRun || Boolean(pending) || statusIsStopping || statusIsConflict;
    const externalActionControls = externalOnly
      ? `${status.canAdopt ? `<button class="button small adopt-button${adoptionPending ? " is-pending" : ""}" type="button" data-action="adopt" data-id="${escapeHtml(project.id)}" ${adoptionPending || pending ? "disabled aria-busy=true" : ""}>${adoptionPending ? "接管中" : "接管"}</button>` : ""}
            ${project.allowStopExternal ? `<button class="button small danger-light" type="button" data-action="stop" data-id="${escapeHtml(project.id)}" ${adoptionPending || pending ? "disabled" : ""}>停止外部</button>
            <button class="button small" type="button" data-action="restart" data-id="${escapeHtml(project.id)}" ${adoptionPending || pending ? "disabled" : ""}>重启</button>` : ""}`
      : "";
    const conflictActionControls = statusIsConflict
      ? `<button class="button small" type="button" data-action="inspect-conflict" data-id="${escapeHtml(project.id)}" ${pending ? "disabled" : ""}>进程详情</button>
            ${status.canStopConflict ? `<button class="button small danger-light" type="button" data-action="stop-port-owner" data-id="${escapeHtml(project.id)}" ${pending ? "disabled" : ""}>关闭占用</button>
            <button class="button small" type="button" data-action="restart-port-owner" data-id="${escapeHtml(project.id)}" ${pending ? "disabled" : ""}>关闭并重启</button>` : ""}`
      : "";
    const multiInstanceStopLabel = externalOnly
      ? "停止外部"
      : (management === "mixed" ? "全部停止" : "停止");
    const runControl = selfManaged
      ? `
            <button class="switch-button switch-self" type="button" role="switch" aria-checked="true" disabled>
              <span class="switch-track"><span class="switch-thumb"></span></span>
              <span class="switch-label">当前运行</span>
            </button>`
      : statusIsConflict
      ? `
            <button class="switch-button switch-off" type="button" role="switch" aria-checked="false" disabled>
              <span class="switch-track"><span class="switch-thumb"></span></span>
              <span class="switch-label">端口冲突</span>
            </button>
            ${conflictActionControls}`
      : project.allowMultiple
      ? `
            <button class="button small project-run-button${startPending ? " is-pending" : ""}" type="button" data-action="start" data-id="${escapeHtml(project.id)}" aria-busy="${startPending ? "true" : "false"}" ${controlsDisabled ? "disabled" : ""}><span class="project-run-label">${startPending ? "启动中" : "启动新实例"}</span></button>
            <button class="button small project-run-button${stopPending ? " is-pending" : ""}" type="button" data-action="stop" data-id="${escapeHtml(project.id)}" aria-busy="${stopPending ? "true" : "false"}" ${controlsDisabled || !actualIsRunning ? "disabled" : ""}><span class="project-run-label">${stopPending ? "停止中" : multiInstanceStopLabel}</span></button>
            ${status.canAdopt ? `<button class="button small adopt-button${adoptionPending ? " is-pending" : ""}" type="button" data-action="adopt" data-id="${escapeHtml(project.id)}" ${adoptionPending ? "disabled aria-busy=true" : ""}>${adoptionPending ? "接管中" : "接管"}</button>` : ""}`
      : externalOnly
      ? `
            <button class="switch-button switch-external" type="button" role="switch" aria-checked="true" disabled>
              <span class="switch-track"><span class="switch-thumb"></span></span>
              <span class="switch-label">外部运行</span>
            </button>
            ${externalActionControls}`
      : `
            <button class="switch-button ${toggleClass}${switchPendingClass}" type="button" data-action="${toggleAction}" data-id="${escapeHtml(project.id)}" role="switch" aria-checked="${displayIsRunning ? "true" : "false"}" aria-busy="${pending || statusIsStopping ? "true" : "false"}" ${controlsDisabled ? "disabled" : ""}>
              <span class="switch-track"><span class="switch-thumb"></span></span>
              <span class="switch-label">${toggleLabel}</span>
            </button>`;
    const canOpenFolder = Boolean(project.cwd || project.path);
    const editControl = `<button class="table-icon-button" type="button" data-action="edit" data-id="${escapeHtml(project.id)}" aria-label="\u7f16\u8f91" title="\u7f16\u8f91">${tableIcons.edit}</button>`;
    const folderControl = `<button class="table-icon-button" type="button" data-action="open-folder" data-id="${escapeHtml(project.id)}" aria-label="\u6253\u5f00\u76ee\u5f55" title="\u6253\u5f00\u76ee\u5f55" ${canOpenFolder ? "" : "disabled"}>${tableIcons.folder}</button>`;
    const codexControl = project.codexCwd
      ? `<button class="button small" type="button" data-action="open-codex" data-id="${escapeHtml(project.id)}">Codex</button>`
      : "";
    const dragControl = canReorder
      ? `<button class="table-icon-button drag-handle" type="button" draggable="true" data-drag-id="${escapeHtml(project.id)}" aria-label="\u62d6\u52a8\u6392\u5e8f" title="\u62d6\u52a8\u6392\u5e8f">${tableIcons.drag}</button>`
      : "";
    const tagList = (project.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
    const favoriteRowClass = project.favorite && state.selectedCategory !== CATEGORY_IDS.favorite ? " favorite-row" : "";
    const actionPendingRowClass = pending || adoptionPending ? " project-action-pending" : "";
    return `
      <tr class="${favoriteRowClass}${actionPendingRowClass}" data-project-id="${escapeHtml(project.id)}">
        <td>
          <div class="project-name">
            <div class="project-title">
              ${dragControl}<span class="project-title-text">${escapeHtml(project.name)}</span>${editControl}
            </div>
            <div class="project-tags">${tagList}</div>
          </div>
        </td>
        <td>
          <div class="status-heading">
            <span class="status-pill status-${escapeHtml(displayStatusState)}">${escapeHtml(statusText[displayStatusState] || displayStatusState)}</span>
            ${managementBadge}
          </div>
          <div class="muted project-status-message">${escapeHtml(displayStatusMessage)}</div>
        </td>
        <td>
${resourceControl}
        </td>
        <td>
          <div class="path-stack">
            <div class="path-cell">
              <div class="mono path-text">${escapeHtml(target)}</div>
              ${folderControl}
            </div>
            ${pidLine}
          </div>
        </td>
        <td>
          <div class="url-cell">
            <div class="url-text">${displayUrl}</div>
          </div>
        </td>
        <td>
          <div class="dev-actions">
${codexControl}
          </div>
        </td>
        <td>
          <div class="actions">
${runControl}
          </div>
        </td>
      </tr>
    `;
  }).join("");

  els.projectRows.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button.dataset.action, button.dataset.id));
  });

  bindDragEvents();
}

function renderResourceCell(memory) {
  const processCount = Number(memory?.processCount || 0);
  if (!processCount) {
    return `<div class="resource-cell empty-resource"><span class="muted">-</span></div>`;
  }

  const workingSet = Number(memory.workingSetBytes || 0);
  const privateBytes = Number(memory.privateBytes || 0);
  const alerts = Array.isArray(memory.alerts) ? memory.alerts : [];
  const alertLevel = alerts.length ? String(memory.alertLevel || "watch") : "normal";
  const alertBadge = alerts.length
    ? `<span class="resource-alert resource-alert-${escapeHtml(alertLevel)}">!</span>`
    : "";
  const alertText = alerts.length ? ` &middot; ${escapeHtml(formatAlertLevel(alertLevel))}` : "";
  const title = formatMemoryTitle(memory);
  return `
          <div class="resource-cell resource-${escapeHtml(alertLevel)}" title="${escapeHtml(title)}">
            <div class="resource-main">${alertBadge}<span>\u5de5\u4f5c\u96c6 ${escapeHtml(formatBytes(workingSet))}</span></div>
            <div class="resource-sub">${escapeHtml(processCount)} \u8fdb\u7a0b &middot; \u79c1\u6709 ${escapeHtml(formatBytes(privateBytes))}${alertText}</div>
          </div>`;
}

function formatMemoryTitle(memory) {
  const processes = Array.isArray(memory?.processes) ? memory.processes : [];
  const alerts = Array.isArray(memory?.alerts) ? memory.alerts : [];
  const lines = [];

  if (alerts.length) {
    lines.push("Memory alerts:");
    for (const alert of alerts) {
      lines.push(formatMemoryAlertLine(alert));
    }
    lines.push("");
  }

  if (!processes.length) {
    lines.push("No process details");
    return lines.join("\n");
  }

  lines.push("Processes:");
  for (const item of processes) {
    const name = item.name ? ` ${item.name}` : "";
    lines.push(`PID ${item.pid}${name}: ${formatBytes(item.workingSetBytes)} working set / ${formatBytes(item.privateBytes)} private`);
  }

  return lines.join("\n");
}

function formatMemoryAlertLine(alert) {
  const parts = [
    `${formatAlertLevel(alert.level)} PID ${alert.pid}${alert.name ? ` ${alert.name}` : ""}`,
    formatAlertReason(alert.reason),
    `current private ${formatBytes(alert.currentPrivateBytes)}`
  ];

  if (Number(alert.deltaBytes) > 0) {
    parts.push(`+${formatBytes(alert.deltaBytes)} in ${formatWindowMinutes(alert.windowMinutes)}`);
    parts.push(`${formatBytes(alert.slopeBytesPerMinute)}/min`);
    parts.push(`${Math.round(Number(alert.increaseRatio || 0) * 100)}% rising samples`);
  }

  return parts.join(" · ");
}

function formatAlertLevel(level) {
  if (level === "critical") return "\u4e25\u91cd";
  if (level === "warning") return "\u544a\u8b66";
  if (level === "watch") return "\u89c2\u5bdf";
  return "\u6b63\u5e38";
}

function formatAlertReason(reason) {
  if (reason === "high_private_memory") return "\u79c1\u6709\u5185\u5b58\u8fc7\u9ad8";
  if (reason === "private_memory_growth") return "\u79c1\u6709\u5185\u5b58\u6301\u7eed\u589e\u957f";
  return reason || "memory alert";
}

function formatWindowMinutes(value) {
  const minutes = Number(value || 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return "current window";
  return `${minutes >= 10 ? Math.round(minutes) : minutes.toFixed(1)} min`;
}
function bindDragEvents() {
  els.projectRows.querySelectorAll("[data-drag-id]").forEach((handle) => {
    handle.addEventListener("click", (event) => event.preventDefault());
    handle.addEventListener("dragstart", (event) => {
      state.draggingId = handle.dataset.dragId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", state.draggingId);
      handle.closest("tr")?.classList.add("dragging");
    });
    handle.addEventListener("dragend", () => resetDragState());
  });

  els.projectRows.querySelectorAll("tr[data-project-id]").forEach((row) => {
    row.addEventListener("dragover", (event) => {
      if (!state.draggingId || row.dataset.projectId === state.draggingId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      markDropTarget(row, event);
    });

    row.addEventListener("dragleave", (event) => {
      if (!row.contains(event.relatedTarget)) {
        row.classList.remove("drop-before", "drop-after");
      }
    });

    row.addEventListener("drop", async (event) => {
      const sourceId = state.draggingId || event.dataTransfer.getData("text/plain");
      const targetId = row.dataset.projectId;
      const insertAfter = row.classList.contains("drop-after");
      event.preventDefault();
      resetDragState();

      if (!sourceId || !targetId || sourceId === targetId) return;
      await saveProjectOrder(sourceId, targetId, insertAfter);
    });
  });
}

function markDropTarget(row, event) {
  els.projectRows.querySelectorAll(".drop-before, .drop-after").forEach((item) => {
    if (item !== row) item.classList.remove("drop-before", "drop-after");
  });

  const rect = row.getBoundingClientRect();
  const insertAfter = event.clientY > rect.top + rect.height / 2;
  row.classList.toggle("drop-before", !insertAfter);
  row.classList.toggle("drop-after", insertAfter);
}

function resetDragState() {
  state.draggingId = null;
  els.projectRows.querySelectorAll(".dragging, .drop-before, .drop-after").forEach((row) => {
    row.classList.remove("dragging", "drop-before", "drop-after");
  });
}

async function saveProjectOrder(sourceId, targetId, insertAfter) {
  const visibleIds = visibleProjects().map((project) => project.id);
  if (!visibleIds.includes(sourceId) || !visibleIds.includes(targetId)) return;

  const reorderedVisibleIds = visibleIds.filter((id) => id !== sourceId);
  const targetIndex = reorderedVisibleIds.indexOf(targetId);
  reorderedVisibleIds.splice(targetIndex + (insertAfter ? 1 : 0), 0, sourceId);

  if (reorderedVisibleIds.join("\u0000") === visibleIds.join("\u0000")) return;

  const visibleSet = new Set(visibleIds);
  const pendingVisibleIds = [...reorderedVisibleIds];
  const ids = state.projects.map((project) => {
    if (!visibleSet.has(project.id)) return project.id;
    return pendingVisibleIds.shift();
  });

  try {
    const data = await api("/api/config/projects/reorder", { method: "POST", body: { ids } });
    applyConfigData(data);
    showToast("\u987a\u5e8f\u5df2\u4fdd\u5b58");
  } catch (error) {
    showToast(error.message || "\u987a\u5e8f\u4fdd\u5b58\u5931\u8d25");
  }
}

function visibleProjects() {
  const projects = filteredProjects();
  if (state.selectedCategory !== CATEGORY_IDS.all) return projects;

  return [...projects].sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)));
}

function filteredProjects() {
  return state.projects.filter((project) => {
    const status = statusOf(project);
    const projectCategory = normalizeCategoryId(project.category);

    if (state.selectedCategory === CATEGORY_IDS.running && status.state !== "running") return false;
    if (state.selectedCategory === CATEGORY_IDS.favorite && !project.favorite) return false;
    if (![CATEGORY_IDS.all, CATEGORY_IDS.running, CATEGORY_IDS.favorite].includes(state.selectedCategory) && projectCategory !== state.selectedCategory) return false;
    if (state.statusFilter !== "all" && status.state !== state.statusFilter) return false;
    if (state.typeFilter !== "all" && project.type !== state.typeFilter) return false;

    if (state.search) {
      const haystack = [
        project.name,
        project.id,
        project.type,
        categoryLabel(project.category),
        project.path,
        project.cwd,
        project.codexCwd,
        project.command,
        project.url,
        project.githubUrl,
        ...(project.tags || [])
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(state.search)) return false;
    }

    return true;
  });
}

async function handleAction(action, id) {
  const project = state.projects.find((item) => item.id === id);
  if (!project) return;

  try {
    if (action === "logs") {
      const data = await api(`/api/projects/${encodeURIComponent(id)}/logs`);
      showModal(`${project.name} 日志`, data.logs || "暂无日志");
      return;
    }

    if (action === "edit") {
      openEditDrawer(id);
      return;
    }

    if (action === "delete") {
      await deleteProject(id);
      return;
    }

    if (action === "adopt") {
      if (pendingProjectAdoptions.has(id)) return;
      const confirmed = window.confirm(`接管“${project.name}”的外部进程？接管后可由项目管理台停止该进程。`);
      if (!confirmed) return;
      pendingProjectAdoptions.add(id);
      render();
      try {
        const data = await api(`/api/projects/${encodeURIComponent(id)}/adopt`, { method: "POST" });
        const commitSequence = ++statusRequestSequence;
        if (!applyProjectStatus(id, data.status, data.runtime, commitSequence)) {
          await refreshProjectStatus(id, { render: false });
        }
        recentProjectActionCompletions.set(id, Date.now());
        showToast(data.message || "外部进程已接管");
      } finally {
        pendingProjectAdoptions.delete(id);
        render();
      }
      return;
    }

    if (action === "inspect-conflict") {
      showPortConflictDetails(project, statusOf(project));
      return;
    }

    if (action === "stop-port-owner" || action === "restart-port-owner") {
      await handlePortOwnerAction(action, project);
      return;
    }

    if (action === "start" || action === "stop" || action === "restart") {
      await handleProjectRunAction(action, project);
      return;
    }

    const data = await api(`/api/projects/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    showToast(data.message || "操作完成");
    if (action === "open-codex") scheduleCodexUsageRefresh(CODEX_AFTER_LAUNCH_REFRESH_MS);
    await refreshProjectStatus(id);
  } catch (error) {
    showToast(error.message || "操作失败");
    await refreshProjectStatus(id).catch(() => {});
  }
}

function showPortConflictDetails(project, status) {
  const conflicts = Array.isArray(status?.conflicts) ? status.conflicts : [];
  const lines = [
    "项目：" + project.name,
    "端口：" + (status?.port || project.port || "-")
  ];
  if (!conflicts.length) {
    lines.push("", "暂无可用的占用进程详情");
  }
  for (const conflict of conflicts) {
    lines.push(
      "",
      "PID：" + (conflict.pid || "-"),
      "进程：" + (conflict.name || "未知"),
      "可执行文件：" + (conflict.executablePath || "未知"),
      "命令行：" + (conflict.commandLine || "未知"),
      "已归属项目：" + (conflict.ownerProjectName || "无")
    );
  }
  showModal("端口占用进程", lines.join("\n"));
}

async function handlePortOwnerAction(action, project) {
  if (pendingProjectActions.has(project.id)) return;
  const status = statusOf(project);
  const expectedPids = Array.isArray(status.conflictPids)
    ? status.conflictPids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
    : [];
  if (!expectedPids.length) {
    showToast("端口占用状态已变化，请刷新后重试");
    await refreshProjectStatus(project.id).catch(() => {});
    return;
  }

  const restarting = action === "restart-port-owner";
  const confirmed = window.confirm(
    (restarting ? "关闭占用进程并重新启动" : "关闭占用进程")
      + "“" + project.name + "”？\nPID：" + expectedPids.join(", ")
      + "\n执行前将重新校验 PID、进程身份和端口归属。"
  );
  if (!confirmed) return;

  const pending = {
    action: restarting ? "start" : "stop",
    targetState: restarting ? "running" : "stopped",
    statusState: restarting ? "starting" : "stopping",
    startedAt: performance.now()
  };
  pendingProjectActions.set(project.id, pending);
  applyPendingProjectActionVisual(project.id, pending);
  let result = null;
  let actionError = null;
  await waitForProjectActionPaint();

  try {
    result = await api(`/api/projects/${encodeURIComponent(project.id)}/${action}`, {
      method: "POST",
      body: { expectedPids }
    });
    if (restarting) {
      await waitForProjectStartConfirmation(project.id);
    } else {
      await waitForProjectStopConfirmation(project.id);
    }
  } catch (error) {
    actionError = error;
    await refreshProjectStatus(project.id, { render: false }).catch(() => {});
    applyProjectActionRollbackVisual(project);
    await waitForProjectActionPaint();
    await waitForProjectActionRollback();
  } finally {
    await waitForMinimumProjectActionFeedback(pending.startedAt);
    recentProjectActionCompletions.set(project.id, Date.now());
    pendingProjectActions.delete(project.id);
    render();
  }

  showToast(actionError?.message || result?.message || (actionError ? "操作失败" : "操作完成"));
}

async function handleProjectRunAction(action, project) {
  if (!project || !["start", "stop", "restart"].includes(action)) return;
  if (pendingProjectActions.has(project.id)) return;

  const visualAction = action === "restart" ? "start" : action;
  const pending = {
    action: visualAction,
    targetState: visualAction === "start" ? "running" : "stopped",
    statusState: visualAction === "start" ? "starting" : "stopping",
    startedAt: performance.now()
  };
  pendingProjectActions.set(project.id, pending);
  applyPendingProjectActionVisual(project.id, pending);

  let result = null;
  let actionError = null;
  await waitForProjectActionPaint();

  try {
    result = await api(`/api/projects/${encodeURIComponent(project.id)}/${action}`, { method: "POST" });
    if (visualAction === "stop") {
      await waitForProjectStopConfirmation(project.id);
    } else {
      await waitForProjectStartConfirmation(project.id);
    }
  } catch (error) {
    actionError = error;
    await refreshProjectStatus(project.id, { render: false }).catch(() => {});
    applyProjectActionRollbackVisual(project);
    await waitForProjectActionPaint();
    await waitForProjectActionRollback();
  } finally {
    await waitForMinimumProjectActionFeedback(pending.startedAt);
    recentProjectActionCompletions.set(project.id, Date.now());
    pendingProjectActions.delete(project.id);
    render();
  }

  showToast(actionError?.message || result?.message || (actionError ? "操作失败" : "操作完成"));
}

function applyPendingProjectActionVisual(projectId, pending) {
  const row = [...els.projectRows.querySelectorAll("tr[data-project-id]")]
    .find((item) => item.dataset.projectId === projectId);
  if (!row) return;

  row.classList.add("project-action-pending");
  const statusPill = row.querySelector(".status-pill");
  if (statusPill) {
    statusPill.className = `status-pill status-${pending.statusState}`;
    statusPill.textContent = pending.action === "start" ? "启动中" : "停止中";
  }
  const statusMessage = row.querySelector(".project-status-message");
  if (statusMessage) {
    statusMessage.textContent = pending.action === "start" ? "正在启动项目" : "正在停止项目";
  }

  const switchControl = row.querySelector(".switch-button");
  if (switchControl) {
    const targetOn = pending.targetState === "running";
    switchControl.classList.remove("switch-on", "switch-off", "switch-pending-start", "switch-pending-stop");
    switchControl.classList.add(targetOn ? "switch-on" : "switch-off", "switch-pending", `switch-pending-${pending.action}`);
    switchControl.setAttribute("aria-checked", targetOn ? "true" : "false");
    switchControl.setAttribute("aria-busy", "true");
    switchControl.disabled = true;
    const label = switchControl.querySelector(".switch-label");
    if (label) label.textContent = pending.action === "start" ? "启动中" : "停止中";
    return;
  }

  row.querySelectorAll(".project-run-button").forEach((button) => {
    button.disabled = true;
    const isActiveAction = button.dataset.action === pending.action;
    button.classList.toggle("is-pending", isActiveAction);
    button.setAttribute("aria-busy", isActiveAction ? "true" : "false");
    if (isActiveAction) {
      const label = button.querySelector(".project-run-label");
      if (label) label.textContent = pending.action === "start" ? "启动中" : "停止中";
    }
  });
}

function applyProjectActionRollbackVisual(project) {
  const row = [...els.projectRows.querySelectorAll("tr[data-project-id]")]
    .find((item) => item.dataset.projectId === project.id);
  if (!row) return;

  const status = statusOf(project);
  const isRunning = status.state === "running" || status.state === "starting";
  row.classList.remove("project-action-pending");

  const statusPill = row.querySelector(".status-pill");
  if (statusPill) {
    statusPill.className = `status-pill status-${status.state}`;
    statusPill.textContent = statusText[status.state] || status.state;
  }
  const statusMessage = row.querySelector(".project-status-message");
  if (statusMessage) statusMessage.textContent = status.message || "";

  const switchControl = row.querySelector(".switch-button");
  if (switchControl) {
    switchControl.classList.remove(
      "switch-on",
      "switch-off",
      "switch-pending",
      "switch-pending-start",
      "switch-pending-stop"
    );
    switchControl.classList.add(isRunning ? "switch-on" : "switch-off");
    switchControl.setAttribute("aria-checked", isRunning ? "true" : "false");
    switchControl.setAttribute("aria-busy", "false");
    switchControl.disabled = true;
    const label = switchControl.querySelector(".switch-label");
    if (label) label.textContent = isRunning ? "停止" : "启动";
    return;
  }

  row.querySelectorAll(".project-run-button").forEach((button) => {
    button.classList.remove("is-pending");
    button.setAttribute("aria-busy", "false");
    button.disabled = true;
    const label = button.querySelector(".project-run-label");
    if (label) label.textContent = button.dataset.action === "start" ? "启动" : "停止";
  });
}

function waitForProjectActionRollback() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, PROJECT_ACTION_ROLLBACK_MS));
}
function waitForProjectActionPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function waitForMinimumProjectActionFeedback(startedAt) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  const remaining = PROJECT_ACTION_MIN_FEEDBACK_MS - (performance.now() - startedAt);
  return remaining > 0
    ? new Promise((resolve) => window.setTimeout(resolve, remaining))
    : Promise.resolve();
}

async function waitForProjectStopConfirmation(id) {
  const deadline = Date.now() + PROJECT_STOP_CONFIRM_TIMEOUT_MS;
  let lastState = "unknown";

  while (true) {
    await refreshProjectStatus(id, { render: false });
    lastState = state.statuses[id]?.state || "unknown";
    if (lastState === "stopped") return;

    if (Date.now() >= deadline) {
      const label = statusText[lastState] || lastState;
      throw new Error(`停止命令已完成，但项目状态仍为“${label}”`);
    }

    await new Promise((resolve) => window.setTimeout(resolve, PROJECT_STOP_CONFIRM_POLL_MS));
  }
}

async function waitForProjectStartConfirmation(id) {
  const deadline = Date.now() + PROJECT_START_CONFIRM_TIMEOUT_MS;
  let lastStatus = { state: "unknown", message: "" };

  while (true) {
    await refreshProjectStatus(id, { render: false });
    lastStatus = state.statuses[id] || lastStatus;
    const currentState = lastStatus.state || "unknown";

    if (currentState === "running") return;

    if (["error", "conflict", "stopped"].includes(currentState)) {
      const label = statusText[currentState] || currentState;
      throw new Error(lastStatus.message || `启动失败，项目状态为“${label}”`);
    }

    if (Date.now() >= deadline) {
      const label = statusText[currentState] || currentState;
      const detail = lastStatus.message ? `：${lastStatus.message}` : "";
      throw new Error(`启动请求已提交，但项目在 32 秒内未进入“运行中”状态；当前为“${label}”${detail}`);
    }

    await new Promise((resolve) => window.setTimeout(resolve, PROJECT_START_CONFIRM_POLL_MS));
  }
}

async function refreshProjectStatus(id, options = {}) {
  const requestSequence = ++statusRequestSequence;
  const data = await api(`/api/projects/${encodeURIComponent(id)}/status`);
  applyProjectStatus(id, data.status, data.runtime, requestSequence);
  if (options.render !== false) render();
}

function applyProjectStatus(id, status, runtime, requestSequence) {
  if (!status) return false;
  const lastAppliedSequence = appliedStatusSequences.get(id) || 0;
  if (requestSequence < lastAppliedSequence) return false;
  state.statuses[id] = {
    ...status,
    runtime
  };
  appliedStatusSequences.set(id, requestSequence);
  return true;
}

function buildFormOptions() {
  els.projectTypeInput.innerHTML = projectTypes.map((type) => (
    '<option value="' + escapeHtml(type) + '">' + escapeHtml(type) + ' - ' + escapeHtml(typeLabels[type] || type) + '</option>'
  )).join("");

  const currentCategory = els.projectCategoryInput.value || CATEGORY_IDS.uncategorized;
  const options = [
    ...getCustomCategories().map((category) => ({ id: category.id, name: category.name })),
    { id: CATEGORY_IDS.uncategorized, name: UNCATEGORIZED_CATEGORY_NAME }
  ];
  els.projectCategoryInput.innerHTML = options.map((category) => (
    '<option value="' + escapeHtml(category.id) + '">' + escapeHtml(category.name) + '</option>'
  )).join("");
  els.projectCategoryInput.value = options.some((category) => category.id === currentCategory) ? currentCategory : CATEGORY_IDS.uncategorized;
}

function openCategoryModal() {
  renderCategoryManager();
  els.categoryModal.showModal();
  setTimeout(() => els.categoryForm.elements.name.focus(), 0);
}

function renderCategoryManager() {
  const categories = getCustomCategories();
  if (!categories.length) {
    els.categoryList.innerHTML = '<div class="category-empty">\u6682\u65e0\u81ea\u5b9a\u4e49\u5206\u7c7b</div>';
    return;
  }

  els.categoryList.innerHTML = categories.map((category, index) => {
    const count = countProjectsInCategory(category.id);
    return `
      <div class="category-item" data-category-id="${escapeHtml(category.id)}">
        <div class="category-meta">
          <strong>${escapeHtml(category.name)}</strong>
          <span>${escapeHtml(count)} \u4e2a\u9879\u76ee</span>
        </div>
        <div class="category-actions">
          <button class="table-icon-button" type="button" data-action="up" data-id="${escapeHtml(category.id)}" title="\u4e0a\u79fb" aria-label="\u4e0a\u79fb" ${index === 0 ? "disabled" : ""}>&#8593;</button>
          <button class="table-icon-button" type="button" data-action="down" data-id="${escapeHtml(category.id)}" title="\u4e0b\u79fb" aria-label="\u4e0b\u79fb" ${index === categories.length - 1 ? "disabled" : ""}>&#8595;</button>
          <button class="button small" type="button" data-action="rename" data-id="${escapeHtml(category.id)}">\u6539\u540d</button>
          <button class="button small danger-light" type="button" data-action="delete" data-id="${escapeHtml(category.id)}">\u5220\u9664</button>
        </div>
      </div>`;
  }).join("");

  els.categoryList.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const { action, id } = button.dataset;
      if (action === "rename") renameCategory(id);
      if (action === "delete") deleteCategoryById(id);
      if (action === "up") moveCategory(id, -1);
      if (action === "down") moveCategory(id, 1);
    });
  });
}

async function submitCategoryForm(event) {
  event.preventDefault();
  const name = els.categoryForm.elements.name.value.trim();
  if (!name) return;

  els.categoryCreateButton.disabled = true;
  try {
    const data = await api("/api/config/categories", { method: "POST", body: { category: { name } } });
    applyConfigData(data);
    els.categoryForm.reset();
    showToast("\u5206\u7c7b\u5df2\u6dfb\u52a0");
    setTimeout(() => els.categoryForm.elements.name.focus(), 0);
  } catch (error) {
    showToast(error.message || "\u5206\u7c7b\u6dfb\u52a0\u5931\u8d25");
  } finally {
    els.categoryCreateButton.disabled = false;
  }
}

async function renameCategory(id) {
  const category = state.categories.find((item) => item.id === id);
  if (!category) return;

  const name = window.prompt("\u5206\u7c7b\u540d\u79f0", category.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === category.name) return;

  try {
    const data = await api("/api/config/categories/" + encodeURIComponent(id), { method: "PUT", body: { category: { name: trimmed } } });
    applyConfigData(data);
    showToast("\u5206\u7c7b\u5df2\u66f4\u65b0");
  } catch (error) {
    showToast(error.message || "\u5206\u7c7b\u66f4\u65b0\u5931\u8d25");
  }
}

async function deleteCategoryById(id) {
  const category = state.categories.find((item) => item.id === id);
  if (!category) return;

  const count = countProjectsInCategory(id);
  const confirmed = window.confirm(`\u5220\u9664\u5206\u7c7b \"${category.name}\"\uff1f${count ? ` ${count} \u4e2a\u9879\u76ee\u5c06\u79fb\u5230${UNCATEGORIZED_CATEGORY_NAME}\u3002` : ""}`);
  if (!confirmed) return;

  try {
    const data = await api("/api/config/categories/" + encodeURIComponent(id), { method: "DELETE" });
    if (state.selectedCategory === id) {
      state.selectedCategory = CATEGORY_IDS.uncategorized;
    }
    applyConfigData(data);
    showToast("\u5206\u7c7b\u5df2\u5220\u9664");
  } catch (error) {
    showToast(error.message || "\u5206\u7c7b\u5220\u9664\u5931\u8d25");
  }
}

async function moveCategory(id, direction) {
  const ids = getCustomCategories().map((category) => category.id);
  const index = ids.indexOf(id);
  const targetIndex = index + direction;
  if (index === -1 || targetIndex < 0 || targetIndex >= ids.length) return;

  [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
  try {
    const data = await api("/api/config/categories/reorder", { method: "POST", body: { ids } });
    applyConfigData(data);
    showToast("\u5206\u7c7b\u987a\u5e8f\u5df2\u4fdd\u5b58");
  } catch (error) {
    showToast(error.message || "\u5206\u7c7b\u6392\u5e8f\u5931\u8d25");
  }
}

function applyConfigData(data) {
  if (Array.isArray(data.projects)) {
    state.projects = data.projects;
  }
  if (Array.isArray(data.categories)) {
    state.categories = data.categories;
  }
  ensureSelectedCategory();
  buildTypeOptions();
  buildFormOptions();
  render();
  if (els.categoryModal.open) {
    renderCategoryManager();
  }
}

function openCreateDrawer() {
  state.drawerMode = "create";
  state.editingId = null;
  clearProjectForm();
  els.drawerTitle.textContent = "\u65b0\u589e\u9879\u76ee";
  els.deleteInDrawerButton.hidden = true;
  els.openDrawerLogButton.hidden = true;
  showFormErrors([]);
  setDrawerOpen(true);
}

function openEditDrawer(id) {
  const project = state.projects.find((item) => item.id === id);
  if (!project) return;

  state.drawerMode = "edit";
  state.editingId = id;
  clearProjectForm();
  fillProjectForm(project);
  els.drawerTitle.textContent = "\u7f16\u8f91\u9879\u76ee - " + project.name;
  els.deleteInDrawerButton.hidden = false;
  els.openDrawerLogButton.hidden = false;
  els.openDrawerLogButton.disabled = false;
  showFormErrors([]);
  setDrawerOpen(true);
}

function closeProjectDrawer() {
  setDrawerOpen(false);
  state.editingId = null;
}

function setDrawerOpen(open) {
  els.drawerBackdrop.hidden = !open;
  els.projectDrawer.classList.toggle("open", open);
  els.projectDrawer.setAttribute("aria-hidden", open ? "false" : "true");
  els.projectDrawer.toggleAttribute("inert", !open);
  if (open) {
    setTimeout(() => els.projectForm.elements.name.focus(), 0);
  }
}

function clearProjectForm() {
  els.projectForm.reset();
  els.projectForm.elements.type.value = "cmd";
  els.projectForm.elements.host.value = "127.0.0.1";
  els.projectForm.elements.detectExternal.checked = true;
  els.projectForm.elements.category.value = CATEGORY_IDS.uncategorized;
  activateDrawerTab("basic");
  syncGithubLink();
  syncTypeFields();
  syncUrlPortWarning();
}

function fillProjectForm(project) {
  const form = els.projectForm.elements;
  form.id.value = project.id || "";
  form.name.value = project.name || "";
  form.type.value = project.type || "cmd";
  form.category.value = normalizeCategoryId(project.category);
  form.tags.value = (project.tags || []).join(", ");
  form.favorite.checked = Boolean(project.favorite);
  form.allowMultiple.checked = Boolean(project.allowMultiple);
  form.hideConsole.checked = Boolean(project.hideConsole);
  form.detectExternal.checked = project.detectExternal !== false;
  form.allowStopExternal.checked = Boolean(project.allowStopExternal);
  form.confirmBeforeStart.checked = Boolean(project.confirmBeforeStart);
  form.path.value = project.path || "";
  form.cwd.value = project.cwd || "";
  form.codexCwd.value = project.codexCwd || "";
  form.githubUrl.value = project.githubUrl || "";
  form.command.value = project.command || "";
  form.url.value = project.url || "";
  form.args.value = Array.isArray(project.args) ? project.args.join("\n") : "";
  form.processMatch.value = Array.isArray(project.processMatch) ? project.processMatch.join("\n") : "";
  form.port.value = project.port || "";
  form.host.value = project.host || "127.0.0.1";
  form.logFile.value = project.logFile || "";
  syncGithubLink();
  syncTypeFields();
  syncUrlPortWarning();
}

function syncTypeFields() {
  const type = els.projectTypeInput.value;
  els.projectForm.querySelectorAll(".type-field").forEach((field) => {
    const types = (field.dataset.show || "").split(",");
    field.hidden = !types.includes(type);
  });

}

function activateDrawerTab(tabName) {
  const availableTabs = [...els.drawerTabs.querySelectorAll("[data-drawer-tab]")].filter((tab) => !tab.hidden);
  const targetTab = availableTabs.find((tab) => tab.dataset.drawerTab === tabName) || availableTabs[0];
  if (!targetTab) return;

  els.drawerTabs.querySelectorAll("[data-drawer-tab]").forEach((tab) => {
    const active = tab === targetTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
  });

  els.projectForm.querySelectorAll("[data-drawer-panel]").forEach((panel) => {
    const active = panel.dataset.drawerPanel === targetTab.dataset.drawerTab;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

function handleDrawerTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;

  const tabs = [...els.drawerTabs.querySelectorAll("[data-drawer-tab]")].filter((tab) => !tab.hidden);
  const currentIndex = tabs.findIndex((tab) => tab.classList.contains("active"));
  if (currentIndex === -1) return;

  event.preventDefault();
  const direction = event.key === "ArrowRight" ? 1 : -1;
  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
  activateDrawerTab(tabs[nextIndex].dataset.drawerTab);
  tabs[nextIndex].focus();
}

function syncGithubLink() {
  const value = els.projectForm.elements.githubUrl.value.trim();
  const href = githubBrowserHref(value);
  if (!href) {
    els.openGithubButton.hidden = true;
    els.openGithubButton.removeAttribute("href");
    return;
  }

  els.openGithubButton.hidden = false;
  els.openGithubButton.href = href;
}

function syncUrlPortWarning() {
  const urlPort = explicitUrlPort(els.projectForm.elements.url.value);
  const configuredPort = els.projectForm.elements.port.value.trim();
  const showWarning = Boolean(urlPort && !configuredPort);

  els.urlPortWarning.hidden = !showWarning;
  els.urlPortWarning.textContent = showWarning
    ? "URL 使用端口 " + urlPort + "，但高级设置中的端口为空；运行状态将自动按 " + urlPort + " 检测。"
    : "";
}

function explicitUrlPort(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.port) return "";
    return url.port;
  } catch {
    return "";
  }
}

async function submitProjectForm(event) {
  event.preventDefault();
  showFormErrors([]);

  if (!els.projectForm.reportValidity()) return;

  const project = collectProjectForm();
  const isEdit = state.drawerMode === "edit" && state.editingId;
  const url = isEdit ? "/api/config/projects/" + encodeURIComponent(state.editingId) : "/api/config/projects";
  const method = isEdit ? "PUT" : "POST";

  setFormBusy(true);
  try {
    const data = await api(url, { method, body: { project } });
    applyConfigData(data);
    closeProjectDrawer();
    await refreshStatuses({ silent: true });
    showToast("\u9879\u76ee\u914d\u7f6e\u5df2\u4fdd\u5b58");
  } catch (error) {
    showFormErrors(error.details || [error.message || "\u4fdd\u5b58\u5931\u8d25"]);
  } finally {
    setFormBusy(false);
  }
}

function collectProjectForm() {
  const formData = new FormData(els.projectForm);
  const project = Object.fromEntries(formData.entries());
  project.favorite = els.projectForm.elements.favorite.checked;
  project.allowMultiple = els.projectForm.elements.allowMultiple.checked;
  project.hideConsole = els.projectForm.elements.hideConsole.checked;
  project.detectExternal = els.projectForm.elements.detectExternal.checked;
  project.allowStopExternal = els.projectForm.elements.allowStopExternal.checked;
  project.confirmBeforeStart = els.projectForm.elements.confirmBeforeStart.checked;

  if (!project.port) delete project.port;
  if (!project.codexCwd) delete project.codexCwd;
  if (!project.githubUrl) delete project.githubUrl;
  if (!project.processMatch) delete project.processMatch;

  if (!["exe", "bat", "file", "folder"].includes(project.type)) delete project.path;
  if (!["exe", "bat", "cmd"].includes(project.type)) {
    delete project.cwd;
    delete project.hideConsole;
  }
  if (project.type !== "cmd") delete project.command;
  if (!["url", "cmd", "exe", "bat"].includes(project.type)) delete project.url;
  if (!["exe", "bat"].includes(project.type)) delete project.args;
  if (!["exe", "bat", "cmd"].includes(project.type)) delete project.processMatch;

  return project;
}

function githubBrowserHref(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/i, "")}`;
  }

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return "";
    return raw;
  } catch {
    return "";
  }
}

async function deleteProject(id) {
  const project = state.projects.find((item) => item.id === id);
  if (!project) return;

  const confirmed = window.confirm("\u786e\u5b9a\u5220\u9664\u9879\u76ee: " + project.name + "\uff1f");
  if (!confirmed) return;

  try {
    const data = await api("/api/config/projects/" + encodeURIComponent(id), { method: "DELETE" });
    delete state.statuses[id];
    applyConfigData(data);
    closeProjectDrawer();
    showToast("\u9879\u76ee\u5df2\u5220\u9664");
  } catch (error) {
    showToast(error.message || "\u5220\u9664\u5931\u8d25");
  }
}

async function openDrawerLogs() {
  if (!state.editingId) return;

  const project = state.projects.find((item) => item.id === state.editingId);
  if (!project) return;

  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/logs`);
    showModal(`${project.name} \u65e5\u5fd7`, data.logs || "\u6682\u65e0\u65e5\u5fd7");
  } catch (error) {
    showToast(error.message || "\u65e5\u5fd7\u6253\u5f00\u5931\u8d25");
  }
}

function showFormErrors(errors) {
  const list = Array.isArray(errors) ? errors.filter(Boolean) : [errors].filter(Boolean);
  els.drawerErrors.hidden = list.length === 0;
  els.drawerErrors.innerHTML = list.map((item) => escapeHtml(item)).join("<br>");
}

function setFormBusy(busy) {
  els.projectSaveButton.disabled = busy;
  els.deleteInDrawerButton.disabled = busy;
  els.openDrawerLogButton.disabled = busy || !state.editingId;
}

function statusOf(project) {
  const status = state.statuses[project.id] || { state: "unknown", message: "尚未检查" };
  return {
    ...status,
    state: status.state || "unknown"
  };
}

async function api(url, options = {}) {
  const request = {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  };

  if (request.body && typeof request.body !== "string") {
    request.body = JSON.stringify(request.body);
  }

  const response = await fetch(url, request);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `\u8bf7\u6c42\u5931\u8d25: ${response.status}`);
    error.details = data.details;
    throw error;
  }
  return data;
}

function showModal(title, body) {
  els.modalTitle.textContent = title;
  els.modalBody.textContent = body;
  els.modal.showModal();
}

let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("show");
  }, 2600);
}

function formatBytes(bytes) {
  let value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const precision = index === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[index]}`;
}
function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
