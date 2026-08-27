const state = {
  projects: [],
  categories: [],
  statuses: {},
  latestRuns: {},
  runLogPreviews: {},
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
let healthRefreshPending = null;
let consecutiveHealthRequestFailures = 0;
let pendingMigrationFile = null;
let pendingMigrationImportToken = null;
let migrationImportInspection = null;
let migrationExportInspection = null;
let activeSystemDialog = null;
const migrationBundleSelections = new Map();
const collapsedLaunchRuns = new Set();
const launchRunSources = new Map();
const launchRunPollTimers = new Map();
const launchRunWaiters = new Map();
const launchRunHistory = new Map();
const launchLogState = {
  runId: null,
  projectId: null,
  stream: "combined",
  offset: 0,
  content: "",
  paused: false,
  loading: false,
  path: "",
  timer: null
};

const els = {
  categoryNav: document.querySelector("#categoryNav"),
  manageCategoriesButton: document.querySelector("#manageCategoriesButton"),
  projectRows: document.querySelector("#projectRows"),
  searchInput: document.querySelector("#searchInput"),
  statusFilter: document.querySelector("#statusFilter"),
  typeFilter: document.querySelector("#typeFilter"),
  newProjectButton: document.querySelector("#newProjectButton"),
  migrationButton: document.querySelector("#migrationButton"),
  summaryText: document.querySelector("#summaryText"),
  systemHealth: document.querySelector("#systemHealth"),
  codexUsage: document.querySelector("#codexUsage"),
  codexUsageLabel: document.querySelector("#codexUsageLabel"),
  codexUsageMeterFill: document.querySelector("#codexUsageMeterFill"),
  codexUsageValue: document.querySelector("#codexUsageValue"),
  codexUsageReset: document.querySelector("#codexUsageReset"),
  logDrawerBackdrop: document.querySelector("#logDrawerBackdrop"),
  launchLogDrawer: document.querySelector("#launchLogDrawer"),
  launchLogTitle: document.querySelector("#launchLogTitle"),
  launchLogSubtitle: document.querySelector("#launchLogSubtitle"),
  launchLogClose: document.querySelector("#launchLogClose"),
  launchLogHistory: document.querySelector("#launchLogHistory"),
  launchLogSummary: document.querySelector("#launchLogSummary"),
  launchLogSearch: document.querySelector("#launchLogSearch"),
  launchLogPause: document.querySelector("#launchLogPause"),
  launchLogEmpty: document.querySelector("#launchLogEmpty"),
  launchLogOutput: document.querySelector("#launchLogOutput"),
  launchLogPath: document.querySelector("#launchLogPath"),
  copyLaunchLogPath: document.querySelector("#copyLaunchLogPath"),
  openLaunchLogFolder: document.querySelector("#openLaunchLogFolder"),
  launchLogCodex: document.querySelector("#launchLogCodex"),
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
  migrationModal: document.querySelector("#migrationModal"),
  migrationModalClose: document.querySelector("#migrationModalClose"),
  migrationExportBadge: document.querySelector("#migrationExportBadge"),
  migrationExportResult: document.querySelector("#migrationExportResult"),
  migrationRescanButton: document.querySelector("#migrationRescanButton"),
  migrationExportButton: document.querySelector("#migrationExportButton"),
  migrationFileInput: document.querySelector("#migrationFileInput"),
  migrationFileButton: document.querySelector("#migrationFileButton"),
  migrationFileName: document.querySelector("#migrationFileName"),
  migrationProjectsRootInput: document.querySelector("#migrationProjectsRootInput"),
  migrationImportBadge: document.querySelector("#migrationImportBadge"),
  migrationImportResult: document.querySelector("#migrationImportResult"),
  migrationInspectButton: document.querySelector("#migrationInspectButton"),
  migrationApplyButton: document.querySelector("#migrationApplyButton"),
  systemDialog: document.querySelector("#systemDialog"),
  systemDialogForm: document.querySelector("#systemDialogForm"),
  systemDialogMark: document.querySelector("#systemDialogMark"),
  systemDialogTitle: document.querySelector("#systemDialogTitle"),
  systemDialogMessage: document.querySelector("#systemDialogMessage"),
  systemDialogDetails: document.querySelector("#systemDialogDetails"),
  systemDialogField: document.querySelector("#systemDialogField"),
  systemDialogInputLabel: document.querySelector("#systemDialogInputLabel"),
  systemDialogInput: document.querySelector("#systemDialogInput"),
  systemDialogInputError: document.querySelector("#systemDialogInputError"),
  systemDialogCancel: document.querySelector("#systemDialogCancel"),
  systemDialogConfirm: document.querySelector("#systemDialogConfirm"),
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
  alternate: "其他端口运行",
  multi_instance: "多实例冲突",
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
const LAUNCH_LOG_POLL_INTERVAL_MS = 700;
const LAUNCH_RUN_SUCCESS_VISIBLE_MS = 2 * 60 * 1000;
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
    loadLatestLaunchRuns(),
    refreshDashboardStatus({ silent: true }),
    refreshCodexUsage({ silent: true })
  ]);
  startStatusPolling();
  window.setInterval(updateLaunchRunElapsed, 1000);
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
  els.launchLogClose.addEventListener("click", closeLaunchLogDrawer);
  els.logDrawerBackdrop.addEventListener("click", closeLaunchLogDrawer);
  els.launchLogHistory.addEventListener("change", () => {
    if (els.launchLogHistory.value) {
      selectLaunchLogRun(els.launchLogHistory.value).catch((error) => showToast(error.message || "日志读取失败"));
    }
  });
  els.launchLogSearch.addEventListener("input", renderLaunchLogOutput);
  els.launchLogPause.addEventListener("click", toggleLaunchLogPause);
  els.copyLaunchLogPath.addEventListener("click", copyCurrentLaunchLogPath);
  els.openLaunchLogFolder.addEventListener("click", openCurrentLaunchLogFolder);
  els.launchLogCodex.addEventListener("click", openCurrentLaunchRunInCodex);
  els.launchLogDrawer.querySelectorAll("[data-log-stream]").forEach((button) => {
    button.addEventListener("click", () => selectLaunchLogStream(button.dataset.logStream));
  });
  els.manageCategoriesButton.addEventListener("click", () => openCategoryModal());
  els.migrationButton.addEventListener("click", () => openMigrationModal());
  els.migrationModalClose.addEventListener("click", () => els.migrationModal.close());
  els.migrationRescanButton.addEventListener("click", () => scanMigrationExport());
  els.migrationExportButton.addEventListener("click", () => exportMigrationPackage());
  els.migrationExportResult.addEventListener("change", handleMigrationBundleSelectionChange);
  els.migrationExportResult.addEventListener("click", handleMigrationBundleSelectionAction);
  els.migrationFileButton.addEventListener("click", () => els.migrationFileInput.click());
  els.migrationFileInput.addEventListener("change", () => loadMigrationFile());
  els.migrationProjectsRootInput.addEventListener("input", () => {
    migrationImportInspection = null;
    pendingMigrationImportToken = null;
    els.migrationApplyButton.disabled = true;
  });
  els.migrationInspectButton.addEventListener("click", () => inspectMigrationImport());
  els.migrationApplyButton.addEventListener("click", () => applyMigrationImport());
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
  els.systemDialogForm.addEventListener("submit", handleSystemDialogSubmit);
  els.systemDialogCancel.addEventListener("click", cancelSystemDialog);
  els.systemDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelSystemDialog();
  });
  els.systemDialog.addEventListener("close", cancelSystemDialog);
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
  if (els.systemDialog.open) return;

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
    return;
  }

  if (event.key === "Escape" && els.launchLogDrawer.getAttribute("aria-hidden") === "false") {
    event.preventDefault();
    closeLaunchLogDrawer();
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

async function loadLatestLaunchRuns() {
  const data = await api("/api/runs");
  state.latestRuns = data.runs || {};
  for (const run of Object.values(state.latestRuns)) {
    launchRunHistory.set(run.id, run);
    if (run?.active) watchLaunchRun(run);
    if (shouldShowLaunchRun(run)) fetchLaunchRunPreview(run.id).catch(() => {});
  }
  render();
}

function watchLaunchRun(run) {
  if (!run?.id) return;
  applyLaunchRunUpdate(run, { renderNow: true });
  if (!run.active || launchRunSources.has(run.id) || launchRunPollTimers.has(run.id)) return;

  const source = new EventSource(`/api/runs/${encodeURIComponent(run.id)}/events`);
  const receive = (event) => {
    try {
      applyLaunchRunUpdate(JSON.parse(event.data), { renderNow: true });
    } catch {
      // Ignore a malformed event and keep the stream alive.
    }
  };
  source.addEventListener("snapshot", receive);
  source.addEventListener("update", receive);
  source.onerror = () => {
    source.close();
    launchRunSources.delete(run.id);
    const latest = state.latestRuns[run.projectId];
    if (latest?.id === run.id && latest.active) startLaunchRunPolling(run.id);
  };
  launchRunSources.set(run.id, source);
}

function startLaunchRunPolling(runId) {
  if (launchRunPollTimers.has(runId)) return;
  const poll = async () => {
    try {
      const data = await api(`/api/runs/${encodeURIComponent(runId)}`);
      applyLaunchRunUpdate(data.run, { renderNow: true });
    } catch {
      // The next polling interval will retry while the backend recovers.
    }
  };
  const timer = window.setInterval(poll, 1000);
  launchRunPollTimers.set(runId, timer);
  poll();
}

function applyLaunchRunUpdate(run, options = {}) {
  if (!run?.id || !run.projectId) return;
  state.latestRuns[run.projectId] = run;
  launchRunHistory.set(run.id, run);
  fetchLaunchRunPreview(run.id).catch(() => {});

  if (!run.active) {
    const source = launchRunSources.get(run.id);
    source?.close();
    launchRunSources.delete(run.id);
    const timer = launchRunPollTimers.get(run.id);
    if (timer) window.clearInterval(timer);
    launchRunPollTimers.delete(run.id);
    settleLaunchRunWaiters(run);
    refreshProjectStatus(run.projectId).catch(() => {});
  }

  if (launchLogState.runId === run.id) {
    renderLaunchLogContext(run);
    if (!launchLogState.paused) pollLaunchLog().catch(() => {});
  }
  if (options.renderNow !== false) render();
}

function waitForLaunchRun(runId) {
  const run = Object.values(state.latestRuns).find((item) => item?.id === runId);
  if (run && !run.active) {
    return run.status === "succeeded"
      ? Promise.resolve(run)
      : Promise.reject(createLaunchRunError(run));
  }
  return new Promise((resolve, reject) => {
    const waiters = launchRunWaiters.get(runId) || [];
    waiters.push({ resolve, reject });
    launchRunWaiters.set(runId, waiters);
  });
}

function settleLaunchRunWaiters(run) {
  const waiters = launchRunWaiters.get(run.id) || [];
  launchRunWaiters.delete(run.id);
  for (const waiter of waiters) {
    if (run.status === "succeeded") waiter.resolve(run);
    else waiter.reject(createLaunchRunError(run));
  }
}

function createLaunchRunError(run) {
  const error = new Error(run.errorMessage || run.message || "启动失败");
  error.run = run;
  return error;
}

async function fetchLaunchRunPreview(runId) {
  const data = await api(`/api/runs/${encodeURIComponent(runId)}/logs?stream=combined&tail=1&maxBytes=6000`);
  const content = String(data.content || "");
  const preview = content.split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
  state.runLogPreviews[runId] = preview;
  const previewElement = document.querySelector(`[data-launch-run-id="${CSS.escape(runId)}"] .launch-run-preview`);
  if (previewElement) previewElement.textContent = preview || "等待命令输出…";
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

function refreshSystemHealth(options = {}) {
  if (healthRefreshPending) return healthRefreshPending;

  const request = refreshSystemHealthOnce(options).finally(() => {
    if (healthRefreshPending === request) healthRefreshPending = null;
  });
  healthRefreshPending = request;
  return request;
}

async function refreshSystemHealthOnce(options = {}) {
  if (!options.background) {
    state.systemHealth = markSystemHealthChecking(state.systemHealth);
    renderSystemHealth();
  }

  try {
    const data = await api("/api/system/health", { timeoutMs: 8000 });
    consecutiveHealthRequestFailures = 0;
    state.systemHealth = await addBrowserExternalFallback(normalizeSystemHealth(data));
    renderSystemHealth();
  } catch (error) {
    consecutiveHealthRequestFailures += 1;
    const checkedAt = new Date().toISOString();
    const recovering = consecutiveHealthRequestFailures > 1;
    state.systemHealth = {
      server: {
        state: "down",
        label: recovering ? "等待恢复" : "连接中断",
        message: error.message || "后台请求失败，托盘将尝试自动恢复",
        checkedAt
      },
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
  const running = state.projects.filter((project) => (
    ["running", "alternate", "multi_instance"].includes(statusOf(project).state)
  )).length;
  const error = state.projects.filter((project) => (
    ["error", "conflict", "multi_instance"].includes(statusOf(project).state)
  )).length;
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
    const auxiliaryPids = Array.isArray(status.auxiliaryPids) ? status.auxiliaryPids.map(Number) : [];
    const alternatePids = Array.isArray(status.alternatePids) ? status.alternatePids.map(Number) : [];
    const selfManaged = status.selfManaged || status.management === "self";
    const selfPids = selfManaged
      ? (status.ownedPortPids || []).map(Number).filter((pid) => !runtimePidSet.has(pid))
      : [];
    const pidTags = [
      ...runtimePids.map((pid) => ({ label: `PID ${pid}`, className: "" })),
      ...selfPids.map((pid) => ({ label: `当前 PID ${pid}`, className: "self-pid" })),
      ...externalPids.map((pid) => ({ label: `\u5916\u90e8 PID ${pid}`, className: "external-pid" })),
      ...auxiliaryPids.map((pid) => ({ label: `\u8f85\u52a9 PID ${pid}`, className: "external-pid" })),
      ...alternatePids.map((pid) => ({ label: `其他端口 PID ${pid}`, className: "external-pid" })),
      ...conflictPids.map((pid) => ({ label: `\u51b2\u7a81 PID ${pid}`, className: "conflict-pid" }))
    ];
    const pidLine = renderPidTags(pidTags);
    const displayUrl = project.url ? `<a class="url-link" href="${escapeHtml(project.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(project.url)}</a>` : "-";
    const resourceControl = renderResourceCell(status.memory);
    const pending = pendingProjectActions.get(project.id);
    const adoptionPending = pendingProjectAdoptions.has(project.id);
    const canRun = runnableTypes.has(project.type);
    const actualIsRunning = ["running", "starting", "alternate", "multi_instance"].includes(status.state);
    const statusIsStopping = status.state === "stopping";
    const statusIsConflict = status.state === "conflict";
    const statusIsAlternate = status.state === "alternate";
    const statusIsMultiInstance = status.state === "multi_instance";
    const management = status.management
      || (status.runtime?.running ? (status.runtime.source === "adopted" ? "adopted" : "managed") : (externalPids.length ? "external" : null));
    const externalOnly = management === "external"
      && actualIsRunning
      && !statusIsAlternate
      && !statusIsMultiInstance;
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
    const processSanitization = status.runtime?.processSanitization;
    const showSanitizationNotice = Number(processSanitization?.removedProcessCount || 0) > 0
      && Date.now() - Number(processSanitization?.at || 0) < 10 * 60 * 1000;
    const sanitizationNotice = showSanitizationNotice
      ? `<div class="process-sanitization-note">已自动清理 ${escapeHtml(processSanitization.removedProcessCount)} 个错误进程记录</div>`
      : "";
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
    const controlsDisabled = !canRun
      || Boolean(pending)
      || statusIsStopping
      || statusIsConflict
      || statusIsAlternate
      || statusIsMultiInstance;
    const externalActionControls = externalOnly
      ? `${status.canAdopt ? `<button class="button small adopt-button${adoptionPending ? " is-pending" : ""}" type="button" data-action="adopt" data-id="${escapeHtml(project.id)}" ${adoptionPending || pending ? "disabled aria-busy=true" : ""}>${adoptionPending ? "接管中" : "接管"}</button>` : ""}
            ${project.allowStopExternal ? `<button class="button small danger-light" type="button" data-action="stop" data-id="${escapeHtml(project.id)}" ${adoptionPending || pending ? "disabled" : ""}>停止外部</button>` : ""}`
      : "";
    const conflictActionControls = statusIsConflict
      ? `<button class="button small" type="button" data-action="inspect-conflict" data-id="${escapeHtml(project.id)}" ${pending ? "disabled" : ""}>进程详情</button>
            ${status.canStopConflict ? `<button class="button small danger-light" type="button" data-action="stop-port-owner" data-id="${escapeHtml(project.id)}" ${pending ? "disabled" : ""}>关闭占用</button>
            <button class="button small" type="button" data-action="restart-port-owner" data-id="${escapeHtml(project.id)}" ${pending ? "disabled" : ""}>关闭并重启</button>` : ""}`
      : "";
    const alternateActionControls = statusIsAlternate || statusIsMultiInstance
      ? `<button class="button small" type="button" data-action="inspect-alternate" data-id="${escapeHtml(project.id)}" ${pending ? "disabled" : ""}>进程详情</button>
            ${status.canStopAlternate ? `<button class="button small danger-light" type="button" data-action="stop-alternate-instances" data-id="${escapeHtml(project.id)}" ${pending ? "disabled" : ""}>关闭现有实例</button>` : ""}`
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
      : statusIsAlternate || statusIsMultiInstance
      ? `
            <button class="switch-button switch-external" type="button" role="switch" aria-checked="true" disabled>
              <span class="switch-track"><span class="switch-thumb"></span></span>
              <span class="switch-label">${statusIsMultiInstance ? "多实例冲突" : "其他端口运行"}</span>
            </button>
            ${alternateActionControls}`
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
    const launchRun = state.latestRuns[project.id];
    const launchAttachmentRowClass = shouldShowLaunchRun(launchRun) ? " project-with-launch-run" : "";
    const projectRow = `
      <tr class="${favoriteRowClass}${actionPendingRowClass}${launchAttachmentRowClass}" data-project-id="${escapeHtml(project.id)}">
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
          ${sanitizationNotice}
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
    return projectRow + renderLaunchRunRow(project, launchRun);
  }).join("");

  els.projectRows.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button.dataset.action, button.dataset.id));
  });
  els.projectRows.querySelectorAll("button[data-run-action]").forEach((button) => {
    button.addEventListener("click", () => handleLaunchRunAction(
      button.dataset.runAction,
      button.dataset.runId,
      button.dataset.projectId
    ));
  });

  bindDragEvents();
}

function renderLaunchRunRow(project, run) {
  if (!shouldShowLaunchRun(run)) return "";
  const collapsed = collapsedLaunchRuns.has(run.id);
  const tone = launchRunTone(run);
  const preview = state.runLogPreviews[run.id] || "";
  const phases = [
    ["validating", "配置"],
    ["checking_ports", "端口"],
    ["spawning", "进程"],
    ["waiting_process", "进程确认"],
    ["waiting_ports", "服务就绪"],
    ["verifying_ownership", "归属核验"]
  ];
  const phaseForSteps = run.failedPhase || run.phase;
  const currentIndex = phases.findIndex(([phase]) => phase === phaseForSteps);
  const terminalSuccess = run.status === "succeeded";
  const segments = phases.map(([phase, label], index) => {
    const complete = terminalSuccess || currentIndex > index;
    const active = (run.active || run.failed) && currentIndex === index;
    return `<li class="${complete ? "complete" : ""}${active ? " active" : ""}"><span aria-hidden="true"></span><em>${escapeHtml(label)}</em></li>`;
  }).join("");
  const customPhase = String(run.phase || "").startsWith("custom:")
    ? `<div class="launch-run-custom-phase"><span>项目上报</span><strong>${escapeHtml(run.phaseLabel)}</strong></div>`
    : "";
  const failureMeta = run.failed
    ? `<div class="launch-run-failure-meta">
        <span>阶段：${escapeHtml(run.failedPhaseLabel || run.phaseLabel || run.failedPhase || run.phase)}</span>
        <span>退出码：${escapeHtml(run.exitCode ?? "未知")}</span>
        ${run.errorCode ? `<span>错误：${escapeHtml(run.errorCode)}</span>` : ""}
      </div>`
    : "";
  const primaryAction = run.failed && run.hasDiagnostic
    ? `<button class="button small primary" type="button" data-run-action="codex" data-run-id="${escapeHtml(run.id)}" data-project-id="${escapeHtml(project.id)}">用 Codex 分析</button>`
    : "";
  const retryAction = run.failed
    ? `<button class="button small secondary" type="button" data-run-action="retry" data-run-id="${escapeHtml(run.id)}" data-project-id="${escapeHtml(project.id)}">重新启动</button>`
    : "";
  const cancelAction = run.canCancel
    ? `<button class="button small danger-light" type="button" data-run-action="cancel" data-run-id="${escapeHtml(run.id)}" data-project-id="${escapeHtml(project.id)}">取消启动</button>`
    : "";

  return `
    <tr class="launch-run-table-row launch-run-${escapeHtml(tone)}${collapsed ? " is-collapsed" : ""}" data-launch-run-id="${escapeHtml(run.id)}">
      <td colspan="7">
        <section class="launch-run-panel" aria-label="${escapeHtml(project.name)} 启动进度">
          <div class="launch-run-head">
            <span class="launch-run-state-mark" aria-hidden="true"></span>
            <div class="launch-run-heading">
              <div class="launch-run-title-line">
                <strong>${escapeHtml(run.phaseLabel || "启动任务")}</strong>
                <span class="launch-run-elapsed" data-run-start="${escapeHtml(run.startedAt || run.createdAt)}" data-run-completed="${escapeHtml(run.completedAt || "")}">${escapeHtml(formatLaunchRunDuration(run))}</span>
              </div>
              <p>${escapeHtml(run.errorMessage || run.message || "")}</p>
            </div>
            <div class="launch-run-head-actions">
              <button class="button small secondary" type="button" data-run-action="logs" data-run-id="${escapeHtml(run.id)}" data-project-id="${escapeHtml(project.id)}">${run.active ? "实时日志" : "查看日志"}</button>
              <button class="launch-run-collapse" type="button" data-run-action="toggle" data-run-id="${escapeHtml(run.id)}" data-project-id="${escapeHtml(project.id)}" aria-expanded="${collapsed ? "false" : "true"}" aria-controls="launch-run-body-${escapeHtml(run.id)}">
                <span data-run-toggle-label>${collapsed ? "展开" : "收起"}</span>
                <span class="launch-run-chevron" aria-hidden="true"></span>
              </button>
            </div>
          </div>
          <div id="launch-run-body-${escapeHtml(run.id)}" class="launch-run-body-shell" aria-hidden="${collapsed ? "true" : "false"}">
            <div class="launch-run-body">
              <div class="launch-run-body-inner">
                <ol class="launch-run-steps" aria-label="通用启动阶段">${segments}</ol>
                ${customPhase}
                ${failureMeta}
                <pre class="launch-run-preview">${escapeHtml(preview || (run.active ? "等待命令输出…" : "本次启动没有命令输出。"))}</pre>
                <div class="launch-run-actions">
                  ${primaryAction}
                  ${retryAction}
                  ${cancelAction}
                  <button class="button small secondary" type="button" data-run-action="folder" data-run-id="${escapeHtml(run.id)}" data-project-id="${escapeHtml(project.id)}">日志目录</button>
                  <span class="launch-run-id">Run ${escapeHtml(run.id)}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </td>
    </tr>`;
}

function shouldShowLaunchRun(run) {
  if (!run?.id) return false;
  if (run.active || run.failed) return true;
  if (["cancelled", "interrupted"].includes(run.status)) return true;
  return Date.now() - Date.parse(run.completedAt || run.updatedAt || 0) < LAUNCH_RUN_SUCCESS_VISIBLE_MS;
}

function launchRunTone(run) {
  if (run.status === "succeeded") return "success";
  if (run.failed) return "failure";
  if (run.status === "cancelled") return "neutral";
  return "active";
}

function formatLaunchRunDuration(run) {
  const start = Date.parse(run.startedAt || run.createdAt || 0);
  const end = run.completedAt ? Date.parse(run.completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  return formatElapsedMilliseconds(Math.max(0, end - start));
}

function formatElapsedMilliseconds(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒` : `${seconds} 秒`;
}

function updateLaunchRunElapsed() {
  document.querySelectorAll(".launch-run-elapsed[data-run-start]").forEach((element) => {
    const start = Date.parse(element.dataset.runStart || 0);
    const completed = Date.parse(element.dataset.runCompleted || "");
    if (!Number.isFinite(start)) return;
    element.textContent = formatElapsedMilliseconds(Math.max(0, (Number.isFinite(completed) ? completed : Date.now()) - start));
  });
}

async function handleLaunchRunAction(action, runId, projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  try {
    if (action === "toggle") {
      const isCollapsed = !collapsedLaunchRuns.has(runId);
      if (isCollapsed) collapsedLaunchRuns.add(runId);
      else collapsedLaunchRuns.delete(runId);

      const row = document.querySelector(`[data-launch-run-id="${CSS.escape(runId)}"]`);
      if (!row) {
        render();
        return;
      }
      row.classList.toggle("is-collapsed", isCollapsed);
      const button = row.querySelector('[data-run-action="toggle"]');
      const body = row.querySelector(".launch-run-body-shell");
      button?.setAttribute("aria-expanded", String(!isCollapsed));
      body?.setAttribute("aria-hidden", String(isCollapsed));
      const label = button?.querySelector("[data-run-toggle-label]");
      if (label) label.textContent = isCollapsed ? "展开" : "收起";
      return;
    }
    if (action === "logs") {
      await openLaunchLogDrawer(projectId, runId);
      return;
    }
    if (action === "folder") {
      const data = await api(`/api/runs/${encodeURIComponent(runId)}/open-folder`, { method: "POST" });
      showToast(data.message || "已打开日志目录");
      return;
    }
    if (action === "codex") {
      await openLaunchRunInCodex(runId);
      return;
    }
    if (action === "retry" && project) {
      await handleProjectRunAction("start", project);
      return;
    }
    if (action === "cancel") {
      const confirmed = await confirmAction({
        title: "取消启动",
        message: `取消“${project?.name || "该项目"}”的启动任务，并清理本次已创建的进程？`,
        details: ["已经写入的启动日志和诊断记录会保留"],
        tone: "warning",
        confirmLabel: "取消启动"
      });
      if (!confirmed) return;
      const data = await api(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
      applyLaunchRunUpdate(data.run, { renderNow: true });
      showToast("正在取消启动");
    }
  } catch (error) {
    showToast(error.message || "启动任务操作失败");
  }
}

async function openLaunchLogDrawer(projectId, runId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  if (els.projectDrawer.getAttribute("aria-hidden") === "false") closeProjectDrawer();
  launchLogState.projectId = projectId;
  els.launchLogTitle.textContent = `${project.name} · 启动日志`;
  els.launchLogSubtitle.textContent = "每次启动独立留存；失败记录可直接交给 Codex 分析";
  setLaunchLogDrawerOpen(true);

  const data = await api(`/api/projects/${encodeURIComponent(projectId)}/runs?limit=20`);
  for (const run of data.runs || []) launchRunHistory.set(run.id, run);
  els.launchLogHistory.innerHTML = (data.runs || []).map((run) => (
    `<option value="${escapeHtml(run.id)}">${escapeHtml(formatDate(run.createdAt))} · ${escapeHtml(launchRunStatusLabel(run))}</option>`
  )).join("");
  const selected = (data.runs || []).some((run) => run.id === runId)
    ? runId
    : data.runs?.[0]?.id;
  if (!selected) {
    els.launchLogSummary.textContent = "暂无启动记录";
    return;
  }
  els.launchLogHistory.value = selected;
  await selectLaunchLogRun(selected);
}

function setLaunchLogDrawerOpen(open) {
  els.logDrawerBackdrop.hidden = !open;
  els.launchLogDrawer.classList.toggle("open", open);
  els.launchLogDrawer.setAttribute("aria-hidden", open ? "false" : "true");
  els.launchLogDrawer.toggleAttribute("inert", !open);
  if (open) window.setTimeout(() => els.launchLogClose.focus(), 0);
}

function closeLaunchLogDrawer() {
  setLaunchLogDrawerOpen(false);
  if (launchLogState.timer) window.clearInterval(launchLogState.timer);
  launchLogState.timer = null;
  launchLogState.runId = null;
  launchLogState.content = "";
  launchLogState.offset = 0;
  launchLogState.paused = false;
  els.launchLogPause.textContent = "暂停";
  els.launchLogPause.setAttribute("aria-pressed", "false");
}

async function selectLaunchLogRun(runId) {
  launchLogState.runId = runId;
  launchLogState.offset = 0;
  launchLogState.content = "";
  launchLogState.path = "";
  els.launchLogHistory.value = runId;
  const cached = launchRunHistory.get(runId);
  if (cached) renderLaunchLogContext(cached);
  await pollLaunchLog({ reset: true });
  if (launchLogState.timer) window.clearInterval(launchLogState.timer);
  launchLogState.timer = window.setInterval(() => pollLaunchLog().catch(() => {}), LAUNCH_LOG_POLL_INTERVAL_MS);
}

function selectLaunchLogStream(stream) {
  if (!["combined", "stdout", "stderr"].includes(stream) || launchLogState.stream === stream) return;
  launchLogState.stream = stream;
  launchLogState.offset = 0;
  launchLogState.content = "";
  els.launchLogDrawer.querySelectorAll("[data-log-stream]").forEach((button) => {
    button.classList.toggle("active", button.dataset.logStream === stream);
  });
  pollLaunchLog({ reset: true }).catch((error) => showToast(error.message || "日志读取失败"));
}

async function pollLaunchLog(options = {}) {
  if (!launchLogState.runId || launchLogState.loading || (launchLogState.paused && !options.reset)) return;
  launchLogState.loading = true;
  try {
    const runId = launchLogState.runId;
    const query = new URLSearchParams({
      stream: launchLogState.stream,
      after: String(options.reset ? 0 : launchLogState.offset),
      maxBytes: String(256 * 1024)
    });
    const data = await api(`/api/runs/${encodeURIComponent(runId)}/logs?${query}`);
    if (launchLogState.runId !== runId) return;
    const wasNearBottom = els.launchLogOutput.scrollHeight - els.launchLogOutput.scrollTop - els.launchLogOutput.clientHeight < 48;
    if (options.reset) launchLogState.content = "";
    launchLogState.content += String(data.content || "");
    if (launchLogState.content.length > 1024 * 1024) {
      launchLogState.content = `[浏览器仅保留最近 1 MB；完整日志仍在本地文件中]\n${launchLogState.content.slice(-1024 * 1024)}`;
    }
    launchLogState.offset = Number(data.nextOffset || 0);
    launchLogState.path = data.path || "";
    els.launchLogPath.textContent = launchLogState.path;
    els.launchLogPath.title = launchLogState.path;
    renderLaunchLogOutput();
    if (wasNearBottom || options.reset) els.launchLogOutput.scrollTop = els.launchLogOutput.scrollHeight;
    if (data.hasMore && !launchLogState.paused) window.setTimeout(() => pollLaunchLog().catch(() => {}), 0);
  } finally {
    launchLogState.loading = false;
  }
}

function renderLaunchLogOutput() {
  const term = els.launchLogSearch.value.trim().toLowerCase();
  const content = term
    ? launchLogState.content.split(/\r?\n/).filter((line) => line.toLowerCase().includes(term)).join("\n")
    : launchLogState.content;
  els.launchLogOutput.textContent = content;
  els.launchLogEmpty.hidden = Boolean(content);
  els.launchLogOutput.hidden = !content;
}

function renderLaunchLogContext(run) {
  if (!run || launchLogState.runId && run.id !== launchLogState.runId) return;
  const tone = launchRunTone(run);
  els.launchLogSummary.className = `launch-log-summary launch-log-${tone}`;
  els.launchLogSummary.innerHTML = `
    <span class="launch-log-status-dot" aria-hidden="true"></span>
    <strong>${escapeHtml(run.phaseLabel || launchRunStatusLabel(run))}</strong>
    <span>${escapeHtml(run.errorMessage || run.message || "")}</span>
    <time>${escapeHtml(formatLaunchRunDuration(run))}</time>`;
  els.launchLogCodex.hidden = !(run.failed && run.hasDiagnostic);
}

function launchRunStatusLabel(run) {
  const labels = {
    queued: "等待启动",
    running: "启动中",
    cancelling: "正在取消",
    succeeded: "启动成功",
    failed: "启动失败",
    cancelled: "已取消",
    interrupted: "任务中断"
  };
  return labels[run?.status] || run?.status || "未知";
}

function toggleLaunchLogPause() {
  launchLogState.paused = !launchLogState.paused;
  els.launchLogPause.textContent = launchLogState.paused ? "继续" : "暂停";
  els.launchLogPause.setAttribute("aria-pressed", launchLogState.paused ? "true" : "false");
  if (!launchLogState.paused) pollLaunchLog().catch(() => {});
}

async function copyCurrentLaunchLogPath() {
  if (!launchLogState.path) return;
  try {
    await navigator.clipboard.writeText(launchLogState.path);
    showToast("日志路径已复制");
  } catch {
    showToast("无法访问剪贴板，请从底部路径手动复制");
  }
}

async function openCurrentLaunchLogFolder() {
  if (!launchLogState.runId) return;
  const data = await api(`/api/runs/${encodeURIComponent(launchLogState.runId)}/open-folder`, { method: "POST" });
  showToast(data.message || "已打开日志目录");
}

async function openCurrentLaunchRunInCodex() {
  if (launchLogState.runId) await openLaunchRunInCodex(launchLogState.runId);
}

async function openLaunchRunInCodex(runId) {
  const data = await api(`/api/runs/${encodeURIComponent(runId)}/open-codex`, { method: "POST" });
  showToast(data.message || "已打开 Codex 诊断会话");
  scheduleCodexUsageRefresh(CODEX_AFTER_LAUNCH_REFRESH_MS);
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

function renderPidTags(tags, visibleLimit = 8) {
  if (!Array.isArray(tags) || !tags.length) return "";

  const renderTag = (tag) => (
    `<span class="pid-tag${tag.className ? ` ${escapeHtml(tag.className)}` : ""}">${escapeHtml(tag.label)}</span>`
  );
  const visibleTags = tags.slice(0, visibleLimit).map(renderTag).join("");
  const hiddenTags = tags.slice(visibleLimit);
  const overflow = hiddenTags.length
    ? `<details class="pid-overflow">
        <summary>另有 ${escapeHtml(hiddenTags.length)} 个</summary>
        <div class="pid-overflow-list">${hiddenTags.map(renderTag).join("")}</div>
      </details>`
    : "";

  return `<div class="pid-tags">${visibleTags}${overflow}</div>`;
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
      const confirmed = await confirmAction({
        title: "接管外部进程",
        message: `接管“${project.name}”的外部进程后，可由项目管理台停止该进程。`,
        confirmLabel: "接管进程"
      });
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

    if (action === "inspect-alternate") {
      showAlternateInstanceDetails(project, statusOf(project));
      return;
    }

    if (action === "stop-alternate-instances") {
      await handleAlternateInstanceStop(project);
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

function showAlternateInstanceDetails(project, status) {
  const instances = Array.isArray(status?.alternateInstances) ? status.alternateInstances : [];
  const lines = [
    "项目：" + project.name,
    "目标端口：" + (status?.port || project.port || "-")
  ];
  if (!instances.length) {
    lines.push("", "未检测到其他端口实例");
  }
  for (const instance of instances) {
    const ports = (Array.isArray(instance.ports) ? instance.ports : [instance.port])
      .map(Number)
      .filter((port) => Number.isInteger(port) && port > 0);
    lines.push(
      "",
      "监听端口：" + (ports.join("、") || "-"),
      "监听 PID：" + ((instance.pids || []).join(", ") || "-"),
      "实例根 PID：" + ((instance.rootPids || []).join(", ") || "-")
    );
    for (const processInfo of instance.processes || []) {
      lines.push(
        "",
        "PID：" + (processInfo.pid || "-"),
        "进程：" + (processInfo.name || "未知"),
        "可执行文件：" + (processInfo.executablePath || "未知"),
        "命令行：" + (processInfo.commandLine || "未知")
      );
    }
  }
  showModal("其他端口实例", lines.join("\n"));
}

async function handleAlternateInstanceStop(project) {
  if (pendingProjectActions.has(project.id)) return;
  const status = statusOf(project);
  const expectedInstances = (Array.isArray(status.alternateInstances) ? status.alternateInstances : [])
    .map((instance) => ({
      ports: (Array.isArray(instance.ports) ? instance.ports : [instance.port])
        .map(Number)
        .filter((port) => Number.isInteger(port) && port > 0),
      pids: (instance.pids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
    }))
    .filter((instance) => instance.ports.length && instance.pids.length);
  if (!expectedInstances.length) {
    showToast("实例状态已变化，请刷新后重试");
    await refreshProjectStatus(project.id).catch(() => {});
    return;
  }

  const instanceDetails = expectedInstances
    .map((instance) => `端口 ${instance.ports.join("、")} · PID ${instance.pids.join(", ")}`);
  const confirmed = await confirmAction({
    title: "关闭现有实例",
    message: `将关闭“${project.name}”在其他端口运行的实例。关闭后不会自动启动目标端口，执行前会重新校验进程身份。`,
    details: instanceDetails,
    tone: "danger",
    confirmLabel: "关闭实例"
  });
  if (!confirmed) return;

  const targetRemainsRunning = status.state === "multi_instance";
  const pending = {
    action: "stop",
    targetState: targetRemainsRunning ? "running" : "stopped",
    statusState: "stopping",
    startedAt: performance.now()
  };
  pendingProjectActions.set(project.id, pending);
  applyPendingProjectActionVisual(project.id, pending);
  let result = null;
  let actionError = null;
  await waitForProjectActionPaint();

  try {
    result = await api(`/api/projects/${encodeURIComponent(project.id)}/stop-alternate-instances`, {
      method: "POST",
      body: { expectedInstances }
    });
    await waitForAlternateInstanceStopConfirmation(project.id);
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
  const confirmed = await confirmAction({
    title: restarting ? "关闭占用进程并重新启动" : "关闭占用进程",
    message: `将关闭占用“${project.name}”目标端口的进程。执行前会重新校验 PID、进程身份和端口归属。`,
    details: expectedPids.map((pid) => `PID ${pid}`),
    tone: "danger",
    confirmLabel: restarting ? "关闭并重启" : "关闭进程"
  });
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
    } else if (result?.run) {
      watchLaunchRun(result.run);
      const completedRun = await waitForLaunchRun(result.run.id);
      result.message = completedRun.message;
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
  const isRunning = ["running", "starting", "alternate", "multi_instance"].includes(status.state);
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

async function waitForAlternateInstanceStopConfirmation(id) {
  const deadline = Date.now() + PROJECT_STOP_CONFIRM_TIMEOUT_MS;
  let lastStatus = {};

  while (true) {
    await refreshProjectStatus(id, { render: false });
    lastStatus = state.statuses[id] || {};
    if (!Array.isArray(lastStatus.alternateInstances) || !lastStatus.alternateInstances.length) return;

    if (Date.now() >= deadline) {
      throw new Error("关闭命令已完成，但其他端口实例仍在监听");
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

    if (["error", "conflict", "alternate", "multi_instance", "stopped"].includes(currentState)) {
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

function openMigrationModal() {
  els.migrationModal.showModal();
  if (!migrationExportInspection) scanMigrationExport();
}

async function scanMigrationExport() {
  els.migrationRescanButton.disabled = true;
  els.migrationExportButton.disabled = true;
  setMigrationBadge(els.migrationExportBadge, "扫描中", "");
  els.migrationExportResult.textContent = "正在检查项目路径和 Git 仓库状态...";
  try {
    migrationExportInspection = await api("/api/migration/export/inspect");
    initializeMigrationBundleSelections(migrationExportInspection.repositories);
    const suggestedRoot = migrationExportInspection.roots?.PROJECTS_ROOT;
    if (suggestedRoot && !els.migrationProjectsRootInput.value.trim()) {
      els.migrationProjectsRootInput.value = suggestedRoot;
    }
    renderMigrationExportInspection(migrationExportInspection);
  } catch (error) {
    migrationExportInspection = null;
    migrationBundleSelections.clear();
    setMigrationBadge(els.migrationExportBadge, "扫描失败", "blocked");
    els.migrationExportResult.innerHTML = renderMigrationError(error);
  } finally {
    els.migrationRescanButton.disabled = false;
  }
}

function renderMigrationExportInspection(inspection) {
  const summary = summarizeMigrationExportSelection(inspection);
  const blockers = inspection.blockers || [];
  const warnings = migrationExportWarnings(inspection);
  const ready = Boolean(inspection.canExport);
  setMigrationBadge(
    els.migrationExportBadge,
    ready ? (warnings.length ? "可导出 · 有提醒" : "可以导出") : `${blockers.length} 个阻止项`,
    ready ? (warnings.length ? "warning" : "ready") : "blocked"
  );
  els.migrationExportResult.innerHTML = `
    <div class="migration-summary">
      <span><strong>${escapeHtml(summary.projectCount || 0)}</strong>项目</span>
      <span><strong>${escapeHtml(summary.repositoryCount || 0)}</strong>仓库</span>
      <span><strong>${escapeHtml(summary.bundledRepositoryCount || 0)}</strong>离线打包</span>
    </div>
    <div class="migration-repository-modes">
      远端恢复 ${escapeHtml(summary.remoteRepositoryCount || 0)} ·
      离线恢复 ${escapeHtml(summary.bundledRepositoryCount || 0)} ·
      手动准备 ${escapeHtml(summary.manualRepositoryCount || 0)}
    </div>
    ${summary.bundleEligibleRepositoryCount ? `
      <div class="migration-bundle-controls" aria-label="离线仓库批量选择">
        <span>离线仓库按仓库去重，关联多个项目时只打包一次</span>
        <div>
          <button type="button" data-migration-bundle-action="select-all">全选离线仓库</button>
          <button type="button" data-migration-bundle-action="select-none">全部取消</button>
        </div>
      </div>
    ` : ""}
    ${renderMigrationRepositories(inspection.repositories, "export")}
    ${renderMigrationIssues(blockers, warnings, "所有仓库均满足安全导出条件。")}
  `;
  els.migrationExportButton.disabled = !ready;
}

async function exportMigrationPackage() {
  els.migrationExportButton.disabled = true;
  els.migrationRescanButton.disabled = true;
  setMigrationBadge(els.migrationExportBadge, "生成中", "");
  try {
    const repositorySelections = (migrationExportInspection?.repositories || [])
      .filter((repository) => repository.bundleEligible)
      .map((repository) => ({
        repositoryId: repository.id,
        includeBundle: migrationBundleSelections.get(repository.id) === true
      }));
    const response = await fetch("/api/migration/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositorySelections,
        inspectionChecksum: migrationExportInspection?.inspectionChecksum
      })
    });
    if (!response.ok) throw await migrationResponseError(response);
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const fileName = match?.[1] || "project-workbench.plwmigrate";
    downloadMigrationBlob(fileName, await response.blob());
    setMigrationBadge(els.migrationExportBadge, "已生成", "ready");
    showToast("迁移包已生成，请妥善保存");
  } catch (error) {
    setMigrationBadge(els.migrationExportBadge, "生成失败", "blocked");
    els.migrationExportResult.innerHTML = renderMigrationError(error);
    if (error.status === 409) {
      migrationExportInspection = null;
      migrationBundleSelections.clear();
    }
    showToast(error.message || "迁移包生成失败");
  } finally {
    els.migrationRescanButton.disabled = false;
    els.migrationExportButton.disabled = !migrationExportInspection?.canExport;
  }
}

async function loadMigrationFile() {
  pendingMigrationFile = null;
  pendingMigrationImportToken = null;
  migrationImportInspection = null;
  els.migrationInspectButton.disabled = true;
  els.migrationApplyButton.disabled = true;
  const file = els.migrationFileInput.files?.[0];
  els.migrationFileName.textContent = file?.name || "未选择文件";
  els.migrationFileName.title = file?.name || "";
  if (!file) {
    setMigrationBadge(els.migrationImportBadge, "未选择", "");
    els.migrationImportResult.textContent = "选择迁移包后将自动执行预检。";
    return;
  }
  if (file.size > 2 * 1024 * 1024 * 1024) {
    setMigrationBadge(els.migrationImportBadge, "文件过大", "blocked");
    els.migrationImportResult.textContent = "迁移包不能超过 2 GB。";
    return;
  }

  pendingMigrationFile = file;
  const currentRoot = migrationExportInspection?.roots?.PROJECTS_ROOT;
  if (!els.migrationProjectsRootInput.value.trim()) {
    els.migrationProjectsRootInput.value = currentRoot || "D:\\Projects";
  }
  els.migrationInspectButton.disabled = false;
  await inspectMigrationImport();
}

async function inspectMigrationImport() {
  if (!pendingMigrationFile) return;
  const projectsRoot = els.migrationProjectsRootInput.value.trim();
  if (!projectsRoot) {
    setMigrationBadge(els.migrationImportBadge, "缺少路径", "blocked");
    els.migrationImportResult.textContent = "请填写新电脑的项目根目录。";
    return;
  }

  els.migrationInspectButton.disabled = true;
  els.migrationApplyButton.disabled = true;
  pendingMigrationImportToken = null;
  setMigrationBadge(els.migrationImportBadge, "预检中", "");
  els.migrationImportResult.textContent = "正在校验迁移包、路径映射和仓库目录...";
  try {
    const response = await fetch(
      `/api/migration/import/inspect?projectsRoot=${encodeURIComponent(projectsRoot)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: pendingMigrationFile
      }
    );
    if (!response.ok) throw await migrationResponseError(response);
    migrationImportInspection = await response.json();
    pendingMigrationImportToken = migrationImportInspection.importToken;
    renderMigrationImportInspection(migrationImportInspection);
  } catch (error) {
    migrationImportInspection = null;
    setMigrationBadge(els.migrationImportBadge, "预检失败", "blocked");
    els.migrationImportResult.innerHTML = renderMigrationError(error);
  } finally {
    els.migrationInspectButton.disabled = !pendingMigrationFile;
  }
}

function renderMigrationImportInspection(inspection) {
  const blockers = inspection.blockers || [];
  const warnings = inspection.warnings || [];
  const packageInfo = inspection.packageInfo || {};
  const ready = Boolean(inspection.canApply);
  setMigrationBadge(
    els.migrationImportBadge,
    ready ? (warnings.length ? "可恢复 · 有提醒" : "可以恢复") : `${blockers.length} 个阻止项`,
    ready ? (warnings.length ? "warning" : "ready") : "blocked"
  );
  els.migrationImportResult.innerHTML = `
    <div class="migration-summary">
      <span><strong>${escapeHtml(packageInfo.projectCount || 0)}</strong>项目</span>
      <span><strong>${escapeHtml(packageInfo.repositoryCount || 0)}</strong>仓库</span>
      <span><strong>v${escapeHtml(packageInfo.schemaVersion || 0)}</strong>格式</span>
    </div>
    ${renderMigrationRepositories(inspection.repositories, "import")}
    ${renderMigrationIssues(blockers, warnings, "迁移包完整且目标配置有效。")}
  `;
  els.migrationApplyButton.disabled = !ready;
}

async function applyMigrationImport() {
  if (!pendingMigrationFile || !pendingMigrationImportToken || !migrationImportInspection?.canApply) return;
  const confirmed = await confirmAction({
    title: "恢复项目配置",
    message: `将恢复 ${migrationImportInspection.packageInfo.projectCount} 个项目配置，并替换当前 projects.json。`,
    details: ["当前配置会先自动备份", "所有管理台项目必须已停止"],
    tone: "warning",
    confirmLabel: "恢复配置"
  });
  if (!confirmed) return;

  els.migrationApplyButton.disabled = true;
  els.migrationInspectButton.disabled = true;
  setMigrationBadge(els.migrationImportBadge, "恢复中", "");
  try {
    const data = await api("/api/migration/import/apply", {
      method: "POST",
      body: {
        importToken: pendingMigrationImportToken,
        rootMappings: { PROJECTS_ROOT: els.migrationProjectsRootInput.value.trim() },
        expectedChecksum: migrationImportInspection.checksum
      }
    });
    state.statuses = {};
    await loadProjects();
    await refreshDashboardStatus({ silent: true });
    setMigrationBadge(els.migrationImportBadge, "恢复完成", "ready");
    els.migrationImportResult.innerHTML = `
      <div class="migration-summary">
        <span><strong>${escapeHtml(data.projectCount || 0)}</strong>项目</span>
        <span><strong>${escapeHtml(data.repositoryCount || 0)}</strong>仓库</span>
        <span><strong>${escapeHtml(data.createdRepositoryCount || 0)}</strong>新恢复仓库</span>
      </div>
      <div>仓库与配置恢复完成，原配置已备份。依赖需按清单安装，项目不会自动启动。</div>
    `;
    showToast("迁移配置已恢复");
  } catch (error) {
    setMigrationBadge(els.migrationImportBadge, "恢复失败", "blocked");
    els.migrationImportResult.innerHTML = renderMigrationError(error);
    els.migrationApplyButton.disabled = !migrationImportInspection?.canApply;
    showToast(error.message || "迁移配置恢复失败");
  } finally {
    els.migrationInspectButton.disabled = !pendingMigrationFile;
  }
}

function renderMigrationIssues(blockers = [], warnings = [], emptyMessage = "检查通过。") {
  const entries = [
    ...blockers.map((entry) => ({ ...entry, level: "blocker" })),
    ...warnings.map((entry) => ({ ...entry, level: "warning" }))
  ];
  if (!entries.length) return `<div>${escapeHtml(emptyMessage)}</div>`;
  const visible = entries.slice(0, 14);
  const hiddenCount = entries.length - visible.length;
  return `
    <ul class="migration-issues">
      ${visible.map((entry) => `<li class="${entry.level}">${escapeHtml(entry.message || entry)}</li>`).join("")}
      ${hiddenCount ? `<li>另有 ${escapeHtml(hiddenCount)} 项未显示</li>` : ""}
    </ul>
  `;
}

function initializeMigrationBundleSelections(repositories = []) {
  migrationBundleSelections.clear();
  for (const repository of repositories) {
    if (!repository.bundleEligible) continue;
    migrationBundleSelections.set(repository.id, Boolean(repository.defaultIncludeBundle));
  }
}

function handleMigrationBundleSelectionChange(event) {
  const checkbox = event.target.closest("[data-migration-repository-id]");
  if (!checkbox || !migrationExportInspection) return;
  migrationBundleSelections.set(checkbox.dataset.migrationRepositoryId, checkbox.checked);
  renderMigrationExportInspection(migrationExportInspection);
}

function handleMigrationBundleSelectionAction(event) {
  const button = event.target.closest("[data-migration-bundle-action]");
  if (!button || !migrationExportInspection) return;
  const includeBundle = button.dataset.migrationBundleAction === "select-all";
  for (const repository of migrationExportInspection.repositories || []) {
    if (repository.bundleEligible) migrationBundleSelections.set(repository.id, includeBundle);
  }
  renderMigrationExportInspection(migrationExportInspection);
}

function migrationSelectedRestoreMode(repository) {
  if (!repository.bundleEligible) return repository.restoreMode || "manual";
  if (migrationBundleSelections.get(repository.id) === true) return "bundle";
  if (repository.state === "git" && repository.remote && repository.upstream && repository.remoteCommit) return "remote";
  return "manual";
}

function summarizeMigrationExportSelection(inspection) {
  const repositories = inspection.repositories || [];
  const modes = repositories.map((repository) => migrationSelectedRestoreMode(repository));
  return {
    ...(inspection.summary || {}),
    repositoryCount: repositories.length,
    remoteRepositoryCount: modes.filter((mode) => mode === "remote").length,
    bundledRepositoryCount: modes.filter((mode) => mode === "bundle").length,
    manualRepositoryCount: modes.filter((mode) => mode === "manual").length,
    bundleEligibleRepositoryCount: repositories.filter((repository) => repository.bundleEligible).length
  };
}

function migrationExportWarnings(inspection) {
  const warnings = (inspection.warnings || []).filter((entry) => (
    !["offline_bundle", "manual_restore"].includes(entry.code)
  ));
  for (const repository of inspection.repositories || []) {
    if (!repository.bundleEligible || migrationBundleSelections.get(repository.id) === true) continue;
    const label = repository.root || repository.remote || repository.id;
    const mode = migrationSelectedRestoreMode(repository);
    if (mode === "remote" && Number(repository.ahead || 0) > 0) {
      warnings.push({
        code: "local_commits_omitted",
        message: `${label} 将不包含本地未推送的 ${repository.ahead} 个提交`
      });
    } else if (mode === "manual") {
      warnings.push({
        code: "bundle_skipped_manual",
        message: `${label} 已取消离线包，需要在新电脑手动复制仓库`
      });
    }
  }
  return warnings;
}

function migrationBundleSelectionDetail(repository, includeBundle) {
  const ahead = Math.max(0, Number(repository.ahead || 0));
  if (includeBundle) {
    if (ahead > 0) return `包含当前提交及 ${ahead} 个未推送提交`;
    return repository.bundleReason === "offline_copy"
      ? "额外包含离线 Git Bundle"
      : "包含当前仓库的离线 Git Bundle";
  }
  const mode = migrationSelectedRestoreMode(repository);
  if (mode === "remote") {
    return ahead > 0
      ? `仅从上游恢复；不包含 ${ahead} 个未推送提交`
      : "仅从远端恢复；不生成离线文件";
  }
  return "已取消离线包；需要在新电脑手动复制";
}

function renderMigrationRepositories(repositories = [], phase = "export") {
  if (!repositories.length) return "";
  const modeLabels = { remote: "远端", bundle: "离线", manual: "手动" };
  const stateLabels = {
    ready: "已存在",
    restorable: "可恢复",
    manual_ready: "手动已准备",
    manual: "需手动",
    not_git: "目录冲突",
    remote_mismatch: "远端不符",
    commit_missing: "缺少提交",
    outside_projects_root: "根目录外"
  };
  return `
    <div class="migration-repository-list">
      ${repositories.map((repository) => {
        const projectIds = repository.projectIds || [];
        if (phase === "export" && repository.bundleEligible) {
          const includeBundle = migrationBundleSelections.get(repository.id) === true;
          const mode = migrationSelectedRestoreMode(repository);
          const detail = migrationBundleSelectionDetail(repository, includeBundle);
          return `
            <div class="migration-repository-row selectable">
              <label class="migration-repository-selection">
                <input
                  type="checkbox"
                  data-migration-repository-id="${escapeHtml(repository.id)}"
                  ${includeBundle ? "checked" : ""}
                >
                <span class="migration-repository-copy">
                  <strong>${escapeHtml(repository.root || repository.remote || repository.id)}</strong>
                  <span>${escapeHtml(projectIds.join("、") || "未关联项目")}</span>
                  <small class="${!includeBundle && (mode !== "remote" || Number(repository.ahead || 0) > 0) ? "warning" : ""}">${escapeHtml(detail)}</small>
                </span>
              </label>
              <span>${escapeHtml(projectIds.length)} 项目 · ${escapeHtml(modeLabels[mode] || "手动")}</span>
            </div>
          `;
        }
        const state = phase === "import"
          ? (stateLabels[repository.state] || repository.state || "待检查")
          : (modeLabels[repository.restoreMode] || "手动");
        return `
          <div class="migration-repository-row">
            <div>
              <strong>${escapeHtml(repository.root || repository.remote || repository.id)}</strong>
              <span>${escapeHtml(projectIds.join("、") || "未关联项目")}</span>
            </div>
            <span>${escapeHtml(projectIds.length)} 项目 · ${escapeHtml(state)}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderMigrationError(error) {
  const details = Array.isArray(error?.details) ? error.details : [];
  return `
    <div>${escapeHtml(error?.message || "操作失败")}</div>
    ${details.length ? renderMigrationIssues(details, []) : ""}
  `;
}

function setMigrationBadge(element, label, stateClass) {
  element.textContent = label;
  element.className = `migration-badge${stateClass ? ` ${stateClass}` : ""}`;
}

function downloadMigrationBlob(fileName, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "project-workbench.plwmigrate";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function migrationResponseError(response) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  const error = new Error(data?.error || `请求失败: ${response.status}`);
  error.status = response.status;
  error.details = data?.details;
  return error;
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

  const name = await promptForText({
    title: "修改分类名称",
    message: "输入新的分类名称。",
    label: "分类名称",
    value: category.name,
    maxLength: 40,
    confirmLabel: "保存",
    validate: (value) => state.categories.some((item) => (
      item.id !== id
      && String(item.name || "").trim().toLocaleLowerCase("zh-CN") === value.toLocaleLowerCase("zh-CN")
    )) ? "分类名称已存在" : ""
  });
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
  const confirmed = await confirmAction({
    title: "删除分类",
    message: `确定删除分类“${category.name}”吗？`,
    details: count
      ? [`${count} 个项目将移到“${UNCATEGORIZED_CATEGORY_NAME}”`, "不会删除项目配置或本地文件"]
      : ["只会删除分类，不会删除项目配置或本地文件"],
    tone: "danger",
    confirmLabel: "删除分类"
  });
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
  els.projectForm.elements.launchMode.value = "foreground";
  els.projectForm.elements.hideConsole.checked = true;
  els.projectForm.elements.allowChildConsole.checked = false;
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
  form.launchMode.value = project.launchMode || "foreground";
  form.startupTimeoutMs.value = project.startupTimeoutMs || "";
  form.hideConsole.checked = Boolean(project.hideConsole);
  form.allowChildConsole.checked = Boolean(project.allowChildConsole);
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
  form.auxiliaryPorts.value = Array.isArray(project.auxiliaryPorts) ? project.auxiliaryPorts.join("\n") : "";
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
  project.allowChildConsole = els.projectForm.elements.allowChildConsole.checked;
  project.detectExternal = els.projectForm.elements.detectExternal.checked;
  project.allowStopExternal = els.projectForm.elements.allowStopExternal.checked;
  project.confirmBeforeStart = els.projectForm.elements.confirmBeforeStart.checked;

  if (!project.port) delete project.port;
  if (!project.startupTimeoutMs) delete project.startupTimeoutMs;
  if (!project.codexCwd) delete project.codexCwd;
  if (!project.githubUrl) delete project.githubUrl;
  if (!project.processMatch) delete project.processMatch;
  if (!project.auxiliaryPorts) delete project.auxiliaryPorts;

  if (!["exe", "bat", "file", "folder"].includes(project.type)) delete project.path;
  if (!["exe", "bat", "cmd"].includes(project.type)) {
    delete project.cwd;
    delete project.hideConsole;
    delete project.allowChildConsole;
    delete project.launchMode;
    delete project.startupTimeoutMs;
  }
  if (project.type !== "cmd") delete project.command;
  if (!["url", "cmd", "exe", "bat"].includes(project.type)) delete project.url;
  if (!["exe", "bat"].includes(project.type)) delete project.args;
  if (!["exe", "bat", "cmd"].includes(project.type)) delete project.processMatch;
  if (!["exe", "bat", "cmd"].includes(project.type)) delete project.auxiliaryPorts;

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

  const confirmed = await confirmAction({
    title: "移除项目配置",
    message: `确定从管理台移除“${project.name}”吗？`,
    details: [
      "只会移除管理台配置，不会删除本地项目文件",
      "当前配置会先自动备份",
      "运行中的项目需先停止"
    ],
    tone: "danger",
    confirmLabel: "移除项目"
  });
  if (!confirmed) return;

  try {
    const data = await api("/api/config/projects/" + encodeURIComponent(id), { method: "DELETE" });
    delete state.statuses[id];
    applyConfigData(data);
    closeProjectDrawer();
    showToast("项目配置已移除");
  } catch (error) {
    showToast(error.message || "移除失败");
  }
}

async function openDrawerLogs() {
  if (!state.editingId) return;

  const project = state.projects.find((item) => item.id === state.editingId);
  if (!project) return;

  try {
    const latestRun = state.latestRuns[project.id];
    if (latestRun?.id) {
      closeProjectDrawer();
      await openLaunchLogDrawer(project.id, latestRun.id);
      return;
    }
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
  const timeoutMs = Number(options.timeoutMs || 0);
  const request = {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  };
  delete request.timeoutMs;

  if (timeoutMs > 0 && !request.signal) {
    request.signal = AbortSignal.timeout(timeoutMs);
  }

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

function confirmAction(options = {}) {
  return openSystemDialog({ ...options, mode: "confirm" });
}

function promptForText(options = {}) {
  return openSystemDialog({ ...options, mode: "prompt" });
}

function openSystemDialog(options = {}) {
  const mode = options.mode === "prompt" ? "prompt" : "confirm";
  const cancelValue = mode === "prompt" ? null : false;
  if (activeSystemDialog) return Promise.resolve(cancelValue);

  const tone = ["default", "warning", "danger"].includes(options.tone)
    ? options.tone
    : "default";
  const details = (Array.isArray(options.details) ? options.details : [])
    .map((detail) => String(detail).trim())
    .filter(Boolean);
  const message = String(options.message || "").trim();

  els.systemDialog.dataset.tone = tone;
  els.systemDialogMark.textContent = mode === "prompt" ? "Aa" : (tone === "default" ? "?" : "!");
  els.systemDialogTitle.textContent = options.title || (mode === "prompt" ? "输入内容" : "确认操作");
  els.systemDialogMessage.textContent = message;
  els.systemDialogMessage.hidden = !message;

  els.systemDialogDetails.replaceChildren(...details.map((detail) => {
    const item = document.createElement("li");
    item.textContent = detail;
    return item;
  }));
  els.systemDialogDetails.hidden = details.length === 0;

  const isPrompt = mode === "prompt";
  els.systemDialogField.hidden = !isPrompt;
  els.systemDialogInput.disabled = !isPrompt;
  els.systemDialogInputLabel.textContent = options.label || "内容";
  els.systemDialogInput.value = isPrompt ? String(options.value || "") : "";
  els.systemDialogInput.placeholder = isPrompt ? String(options.placeholder || "") : "";
  const maxLength = Number(options.maxLength);
  if (isPrompt && Number.isInteger(maxLength) && maxLength > 0) {
    els.systemDialogInput.maxLength = maxLength;
  } else {
    els.systemDialogInput.removeAttribute("maxlength");
  }

  showSystemDialogInputError("");
  els.systemDialogCancel.textContent = options.cancelLabel || "取消";
  els.systemDialogConfirm.textContent = options.confirmLabel || (isPrompt ? "保存" : "确认");
  els.systemDialogConfirm.className = `button ${tone === "danger" ? "danger" : "primary"}`;

  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return new Promise((resolve) => {
    activeSystemDialog = {
      mode,
      tone,
      resolve,
      trigger,
      validate: typeof options.validate === "function" ? options.validate : null
    };
    els.systemDialog.showModal();
    window.requestAnimationFrame(() => {
      if (!activeSystemDialog) return;
      const target = isPrompt
        ? els.systemDialogInput
        : (tone === "danger" ? els.systemDialogCancel : els.systemDialogConfirm);
      target.focus();
      if (isPrompt) target.select();
    });
  });
}

function handleSystemDialogSubmit(event) {
  event.preventDefault();
  if (!activeSystemDialog) return;

  if (activeSystemDialog.mode === "confirm") {
    settleSystemDialog(true);
    return;
  }

  const value = els.systemDialogInput.value.trim();
  let errorMessage = value ? "" : `请输入${els.systemDialogInputLabel.textContent}`;
  if (!errorMessage && activeSystemDialog.validate) {
    errorMessage = String(activeSystemDialog.validate(value) || "");
  }
  if (errorMessage) {
    showSystemDialogInputError(errorMessage);
    els.systemDialogInput.focus();
    return;
  }

  settleSystemDialog(value);
}

function showSystemDialogInputError(message) {
  els.systemDialogInputError.textContent = message;
  els.systemDialogInputError.hidden = !message;
}

function cancelSystemDialog() {
  if (!activeSystemDialog) return;
  settleSystemDialog(activeSystemDialog.mode === "prompt" ? null : false);
}

function settleSystemDialog(value) {
  const session = activeSystemDialog;
  if (!session) return;
  activeSystemDialog = null;
  if (els.systemDialog.open) {
    els.systemDialog.close(value === false || value === null ? "cancel" : "confirm");
  }
  session.resolve(value);
  window.setTimeout(() => {
    if (session.trigger?.isConnected) session.trigger.focus();
  }, 0);
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
