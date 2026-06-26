const state = {
  projects: [],
  statuses: {},
  selectedCategory: "全部项目",
  search: "",
  statusFilter: "all",
  typeFilter: "all"
};

const els = {
  categoryNav: document.querySelector("#categoryNav"),
  projectRows: document.querySelector("#projectRows"),
  searchInput: document.querySelector("#searchInput"),
  statusFilter: document.querySelector("#statusFilter"),
  typeFilter: document.querySelector("#typeFilter"),
  refreshButton: document.querySelector("#refreshButton"),
  bulkStartButton: document.querySelector("#bulkStartButton"),
  summaryText: document.querySelector("#summaryText"),
  modal: document.querySelector("#modal"),
  modalTitle: document.querySelector("#modalTitle"),
  modalBody: document.querySelector("#modalBody"),
  modalClose: document.querySelector("#modalClose"),
  toast: document.querySelector("#toast")
};

const statusText = {
  running: "运行中",
  starting: "启动中",
  stopped: "未启动",
  error: "异常",
  unknown: "未知"
};

const runnableTypes = new Set(["exe", "bat", "cmd"]);

init().catch((error) => showToast(error.message || "初始化失败"));

async function init() {
  bindEvents();
  await loadProjects();
  await refreshStatuses();
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

  els.refreshButton.addEventListener("click", () => refreshStatuses());
  els.bulkStartButton.addEventListener("click", () => bulkStartVisibleProjects());
  els.modalClose.addEventListener("click", () => els.modal.close());
}

async function loadProjects() {
  const data = await api("/api/projects");
  state.projects = data.projects || [];
  buildTypeOptions();
  render();
}

async function refreshStatuses() {
  els.refreshButton.disabled = true;
  try {
    const data = await api("/api/status/all");
    state.statuses = data.statuses || {};
    render();
    showToast("状态检查完成");
  } finally {
    els.refreshButton.disabled = false;
  }
}

function buildTypeOptions() {
  const current = els.typeFilter.value;
  const types = [...new Set(state.projects.map((project) => project.type).filter(Boolean))].sort();
  els.typeFilter.innerHTML = `<option value="all">全部类型</option>${types.map((type) => (
    `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`
  )).join("")}`;
  els.typeFilter.value = types.includes(current) ? current : "all";
  state.typeFilter = els.typeFilter.value;
}

function render() {
  renderCategories();
  renderSummary();
  renderTable();
}

function renderCategories() {
  const categories = getCategories();
  els.categoryNav.innerHTML = categories.map((item) => `
    <button class="nav-button ${item.name === state.selectedCategory ? "active" : ""}" type="button" data-category="${escapeHtml(item.name)}">
      <span>${escapeHtml(item.name)}</span>
      <span class="nav-count">${item.count}</span>
    </button>
  `).join("");

  els.categoryNav.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCategory = button.dataset.category;
      render();
    });
  });
}

function getCategories() {
  const fixed = [
    { name: "全部项目", count: state.projects.length },
    { name: "正在运行", count: state.projects.filter((project) => statusOf(project).state === "running").length },
    { name: "收藏", count: state.projects.filter((project) => project.favorite).length }
  ];

  const custom = [...new Set(state.projects.map((project) => project.category || "未分类"))]
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((name) => ({
      name,
      count: state.projects.filter((project) => (project.category || "未分类") === name).length
    }));

  return [...fixed, ...custom];
}

function renderSummary() {
  const total = state.projects.length;
  const running = state.projects.filter((project) => statusOf(project).state === "running").length;
  const error = state.projects.filter((project) => statusOf(project).state === "error").length;
  els.summaryText.textContent = `${total} 个项目，${running} 个运行中，${error} 个异常`;
}

function renderTable() {
  const projects = filteredProjects();

  if (!projects.length) {
    els.projectRows.innerHTML = `<tr><td colspan="7" class="empty-cell">没有匹配的项目</td></tr>`;
    return;
  }

  els.projectRows.innerHTML = projects.map((project) => {
    const status = statusOf(project);
    const runtime = status.runtime || {};
    const lastStarted = runtime.startedAt ? formatDate(runtime.startedAt) : "-";
    const target = project.command || project.path || project.url || "-";
    const portOrUrl = [project.port ? `:${project.port}` : "", project.url || ""].filter(Boolean).join(" ");
    const canStop = runnableTypes.has(project.type);
    const canOpenFolder = Boolean(project.cwd || project.path);
    return `
      <tr>
        <td>
          <div class="project-name">
            <div class="project-title">
              <span>${project.favorite ? `<span class="favorite">★</span>` : ""}${escapeHtml(project.name)}</span>
            </div>
            <div class="project-tags">${(project.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
          </div>
        </td>
        <td>
          <span class="status-pill status-${escapeHtml(status.state)}">${escapeHtml(statusText[status.state] || status.state)}</span>
          <div class="muted">${escapeHtml(status.message || "")}</div>
        </td>
        <td><span class="mono">${escapeHtml(project.type)}</span></td>
        <td><div class="mono">${escapeHtml(target)}</div></td>
        <td><div class="mono">${escapeHtml(portOrUrl || "-")}</div></td>
        <td><span class="muted">${escapeHtml(lastStarted)}</span></td>
        <td>
          <div class="actions">
            <button class="button small" type="button" data-action="start" data-id="${escapeHtml(project.id)}">启动</button>
            <button class="button small" type="button" data-action="stop" data-id="${escapeHtml(project.id)}" ${canStop ? "" : "disabled"}>停止</button>
            <button class="button small" type="button" data-action="restart" data-id="${escapeHtml(project.id)}" ${canStop ? "" : "disabled"}>重启</button>
            <button class="button small" type="button" data-action="open-url" data-id="${escapeHtml(project.id)}" ${project.url ? "" : "disabled"}>网页</button>
            <button class="button small" type="button" data-action="open-folder" data-id="${escapeHtml(project.id)}" ${canOpenFolder ? "" : "disabled"}>目录</button>
            <button class="button small" type="button" data-action="logs" data-id="${escapeHtml(project.id)}">日志</button>
            <button class="button small" type="button" data-action="config" data-id="${escapeHtml(project.id)}">配置</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  els.projectRows.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button.dataset.action, button.dataset.id));
  });
}

function filteredProjects() {
  return state.projects.filter((project) => {
    const status = statusOf(project);

    if (state.selectedCategory === "正在运行" && status.state !== "running") return false;
    if (state.selectedCategory === "收藏" && !project.favorite) return false;
    if (!["全部项目", "正在运行", "收藏"].includes(state.selectedCategory) && project.category !== state.selectedCategory) return false;
    if (state.statusFilter !== "all" && status.state !== state.statusFilter) return false;
    if (state.typeFilter !== "all" && project.type !== state.typeFilter) return false;

    if (state.search) {
      const haystack = [
        project.name,
        project.id,
        project.type,
        project.category,
        project.path,
        project.cwd,
        project.command,
        project.url,
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

    if (action === "config") {
      showModal(`${project.name} 配置`, JSON.stringify(project, null, 2));
      return;
    }

    const data = await api(`/api/projects/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    showToast(data.message || "操作完成");
    await refreshProjectStatus(id);
  } catch (error) {
    showToast(error.message || "操作失败");
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

async function bulkStartVisibleProjects() {
  const projects = filteredProjects().filter((project) => runnableTypes.has(project.type));
  if (!projects.length) {
    showToast("当前筛选结果没有可启动项目");
    return;
  }

  const confirmed = window.confirm(`将启动当前筛选结果中的 ${projects.length} 个可运行项目。`);
  if (!confirmed) return;

  els.bulkStartButton.disabled = true;
  try {
    for (const project of projects) {
      await api(`/api/projects/${encodeURIComponent(project.id)}/start`, { method: "POST" });
      await refreshProjectStatus(project.id);
    }
    showToast("批量启动完成");
  } catch (error) {
    showToast(error.message || "批量启动失败");
  } finally {
    els.bulkStartButton.disabled = false;
  }
}

function statusOf(project) {
  const status = state.statuses[project.id] || { state: "unknown", message: "尚未检查" };
  return {
    ...status,
    state: status.state || "unknown"
  };
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `请求失败: ${response.status}`);
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
