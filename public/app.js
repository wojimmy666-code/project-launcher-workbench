const state = {
  projects: [],
  categories: [],
  statuses: {},
  systemHealth: {
    server: { state: "checking", label: "检查中" },
    network: { state: "checking", label: "检查中" },
    external: { state: "checking", label: "检查中" }
  },
  selectedCategory: "all",
  search: "",
  statusFilter: "all",
  typeFilter: "all",
  drawerMode: "create",
  editingId: null,
  draggingId: null
};

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
  stopped: "未启动",
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
  await refreshDashboardStatus({ silent: true });
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

async function refreshStatuses(options = {}) {
  const data = await api("/api/status/all");
  state.statuses = data.statuses || {};
  render();
  if (!options.silent) showToast("\u72b6\u6001\u68c0\u67e5\u5b8c\u6210");
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
    state.systemHealth = normalizeSystemHealth(data);
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
  if (Number.isFinite(Number(info.latencyMs))) lines.push(`响应：${Math.round(Number(info.latencyMs))}ms`);
  if (info.statusCode) lines.push(`状态码：${info.statusCode}`);
  if (info.message) lines.push(`说明：${info.message}`);
  const checkedAt = info.checkedAt || fallbackCheckedAt;
  if (checkedAt) lines.push(`检查时间：${formatHealthTime(checkedAt)}`);
  return lines.join("\n");
}

function formatHealthTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return formatDate(date);
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
  const error = state.projects.filter((project) => statusOf(project).state === "error").length;
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
    const pidTags = [
      ...runtimePids.map((pid) => `<span class="pid-tag">PID ${escapeHtml(pid)}</span>`),
      ...externalPids.map((pid) => `<span class="pid-tag external-pid">\u5916\u90e8 PID ${escapeHtml(pid)}</span>`)
    ];
    const pidLine = pidTags.length ? `<div class="pid-tags">${pidTags.join("")}</div>` : "";
    const displayUrl = project.url ? `<a class="url-link" href="${escapeHtml(project.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(project.url)}</a>` : "-";
    const resourceControl = renderResourceCell(status.memory);
    const canRun = runnableTypes.has(project.type);
    const isRunning = status.state === "running" || status.state === "starting";
    const toggleAction = isRunning ? "stop" : "start";
    const toggleLabel = isRunning ? "\u505c\u6b62" : "\u542f\u52a8";
    const toggleClass = isRunning ? "switch-on" : "switch-off";
    const runControl = project.allowMultiple
      ? `
            <button class="button small" type="button" data-action="start" data-id="${escapeHtml(project.id)}" ${canRun ? "" : "disabled"}>\u542f\u52a8</button>
            <button class="button small" type="button" data-action="stop" data-id="${escapeHtml(project.id)}" ${canRun && isRunning ? "" : "disabled"}>\u505c\u6b62</button>`
      : `
            <button class="switch-button ${toggleClass}" type="button" data-action="${toggleAction}" data-id="${escapeHtml(project.id)}" role="switch" aria-checked="${isRunning ? "true" : "false"}" ${canRun ? "" : "disabled"}>
              <span class="switch-track"><span class="switch-thumb"></span></span>
              <span>${toggleLabel}</span>
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
    return `
      <tr class="${favoriteRowClass}" data-project-id="${escapeHtml(project.id)}">
        <td>
          <div class="project-name">
            <div class="project-title">
              ${dragControl}<span class="project-title-text">${escapeHtml(project.name)}</span>${editControl}
            </div>
            <div class="project-tags">${tagList}</div>
          </div>
        </td>
        <td>
          <span class="status-pill status-${escapeHtml(status.state)}">${escapeHtml(statusText[status.state] || status.state)}</span>
          <div class="muted">${escapeHtml(status.message || "")}</div>
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
            <div class="resource-main">${alertBadge}<span>\u5185\u5b58 ${escapeHtml(formatBytes(workingSet))}</span></div>
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

    const data = await api(`/api/projects/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    showToast(data.message || "操作完成");
    await refreshProjectStatus(id);
  } catch (error) {
    showToast(error.message || "操作失败");
    await refreshProjectStatus(id).catch(() => {});
  }
}

async function refreshProjectStatus(id) {
  const data = await api(`/api/projects/${encodeURIComponent(id)}/status`);
  state.statuses[id] = {
    ...(data.status || {}),
    runtime: data.runtime
  };
  render();
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
  form.port.value = project.port || "";
  form.host.value = project.host || "127.0.0.1";
  form.logFile.value = project.logFile || "";
  syncGithubLink();
  syncTypeFields();
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
  project.detectExternal = els.projectForm.elements.detectExternal.checked;
  project.allowStopExternal = els.projectForm.elements.allowStopExternal.checked;
  project.confirmBeforeStart = els.projectForm.elements.confirmBeforeStart.checked;

  if (!project.port) delete project.port;
  if (!project.codexCwd) delete project.codexCwd;
  if (!project.githubUrl) delete project.githubUrl;

  if (!["exe", "bat", "file", "folder"].includes(project.type)) delete project.path;
  if (!["exe", "bat", "cmd"].includes(project.type)) delete project.cwd;
  if (project.type !== "cmd") delete project.command;
  if (!["url", "cmd", "exe", "bat"].includes(project.type)) delete project.url;
  if (!["exe", "bat"].includes(project.type)) delete project.args;

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
