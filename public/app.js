const state = {
  projects: [],
  statuses: {},
  selectedCategory: "全部项目",
  search: "",
  statusFilter: "all",
  typeFilter: "all",
  drawerMode: "create",
  editingId: null
};

const els = {
  categoryNav: document.querySelector("#categoryNav"),
  projectRows: document.querySelector("#projectRows"),
  searchInput: document.querySelector("#searchInput"),
  statusFilter: document.querySelector("#statusFilter"),
  typeFilter: document.querySelector("#typeFilter"),
  newProjectButton: document.querySelector("#newProjectButton"),
  refreshButton: document.querySelector("#refreshButton"),
  bulkStartButton: document.querySelector("#bulkStartButton"),
  summaryText: document.querySelector("#summaryText"),
  drawerBackdrop: document.querySelector("#drawerBackdrop"),
  projectDrawer: document.querySelector("#projectDrawer"),
  projectForm: document.querySelector("#projectForm"),
  drawerTitle: document.querySelector("#drawerTitle"),
  drawerClose: document.querySelector("#drawerClose"),
  drawerCancel: document.querySelector("#drawerCancel"),
  drawerErrors: document.querySelector("#drawerErrors"),
  deleteInDrawerButton: document.querySelector("#deleteInDrawerButton"),
  openDrawerLogButton: document.querySelector("#openDrawerLogButton"),
  projectSaveButton: document.querySelector("#projectSaveButton"),
  projectTypeInput: document.querySelector("#projectForm select[name=\"type\"]"),
  categoryOptions: document.querySelector("#categoryOptions"),
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

const tableIcons = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>'
};

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
  els.newProjectButton.addEventListener("click", () => openCreateDrawer());
  els.drawerClose.addEventListener("click", () => closeProjectDrawer());
  els.drawerCancel.addEventListener("click", () => closeProjectDrawer());
  els.drawerBackdrop.addEventListener("click", () => closeProjectDrawer());
  els.projectTypeInput.addEventListener("change", () => syncTypeFields());
  els.projectForm.addEventListener("submit", (event) => submitProjectForm(event));
  els.deleteInDrawerButton.addEventListener("click", () => {
    if (state.editingId) deleteProject(state.editingId);
  });
  els.openDrawerLogButton.addEventListener("click", () => openDrawerLogs());
  els.modalClose.addEventListener("click", () => els.modal.close());
}

async function loadProjects() {
  const data = await api("/api/projects");
  state.projects = data.projects || [];
  buildTypeOptions();
  buildFormOptions();
  render();
}

async function refreshStatuses(options = {}) {
  els.refreshButton.disabled = true;
  try {
    const data = await api("/api/status/all");
    state.statuses = data.statuses || {};
    render();
    if (!options.silent) showToast("\u72b6\u6001\u68c0\u67e5\u5b8c\u6210");
  } finally {
    els.refreshButton.disabled = false;
  }
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
    els.projectRows.innerHTML = `<tr><td colspan="5" class="empty-cell">没有匹配的项目</td></tr>`;
    return;
  }

  els.projectRows.innerHTML = projects.map((project) => {
    const status = statusOf(project);
    const target = project.command || project.path || project.url || "-";
    const portOrUrl = [project.port ? `:${project.port}` : "", project.url || ""].filter(Boolean).join(" ");
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
    const openUrlControl = project.url
      ? `<button class="button small" type="button" data-action="open-url" data-id="${escapeHtml(project.id)}">\u7f51\u9875</button>`
      : "";
    const editControl = `<button class="table-icon-button" type="button" data-action="edit" data-id="${escapeHtml(project.id)}" aria-label="\u7f16\u8f91" title="\u7f16\u8f91">${tableIcons.edit}</button>`;
    const folderControl = `<button class="table-icon-button" type="button" data-action="open-folder" data-id="${escapeHtml(project.id)}" aria-label="\u6253\u5f00\u76ee\u5f55" title="\u6253\u5f00\u76ee\u5f55" ${canOpenFolder ? "" : "disabled"}>${tableIcons.folder}</button>`;
    return `
      <tr>
        <td>
          <div class="project-name">
            <div class="project-title">
              <span class="project-title-text">${project.favorite ? `<span class="favorite">&#9733;</span>` : ""}${escapeHtml(project.name)}</span>${editControl}
            </div>
            <div class="project-tags">${(project.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
          </div>
        </td>
        <td>
          <span class="status-pill status-${escapeHtml(status.state)}">${escapeHtml(statusText[status.state] || status.state)}</span>
          <div class="muted">${escapeHtml(status.message || "")}</div>
        </td>
        <td>
          <div class="path-cell">
            <div class="mono path-text">${escapeHtml(target)}</div>
            ${folderControl}
          </div>
        </td>
        <td><div class="mono">${escapeHtml(portOrUrl || "-")}</div></td>
        <td>
          <div class="actions">
${runControl}
${openUrlControl}
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

function buildFormOptions() {
  els.projectTypeInput.innerHTML = projectTypes.map((type) => (
    '<option value="' + escapeHtml(type) + '">' + escapeHtml(type) + ' - ' + escapeHtml(typeLabels[type] || type) + '</option>'
  )).join("");

  const categories = [...new Set(state.projects.map((project) => project.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  els.categoryOptions.innerHTML = categories.map((category) => '<option value="' + escapeHtml(category) + '"></option>').join("");
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
  if (open) {
    setTimeout(() => els.projectForm.elements.name.focus(), 0);
  }
}

function clearProjectForm() {
  els.projectForm.reset();
  els.projectForm.elements.type.value = "cmd";
  els.projectForm.elements.host.value = "127.0.0.1";
  syncTypeFields();
}

function fillProjectForm(project) {
  const form = els.projectForm.elements;
  form.id.value = project.id || "";
  form.name.value = project.name || "";
  form.type.value = project.type || "cmd";
  form.category.value = project.category || "";
  form.tags.value = (project.tags || []).join(", ");
  form.favorite.checked = Boolean(project.favorite);
  form.allowMultiple.checked = Boolean(project.allowMultiple);
  form.dangerous.checked = Boolean(project.dangerous);
  form.confirmBeforeStart.checked = Boolean(project.confirmBeforeStart);
  form.path.value = project.path || "";
  form.cwd.value = project.cwd || "";
  form.command.value = project.command || "";
  form.url.value = project.url || "";
  form.args.value = Array.isArray(project.args) ? project.args.join("\n") : "";
  form.port.value = project.port || "";
  form.host.value = project.host || "127.0.0.1";
  form.logFile.value = project.logFile || "";
  syncTypeFields();
}

function syncTypeFields() {
  const type = els.projectTypeInput.value;
  els.projectForm.querySelectorAll(".type-field").forEach((field) => {
    const types = (field.dataset.show || "").split(",");
    field.hidden = !types.includes(type);
  });
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
    state.projects = data.projects || [];
    buildTypeOptions();
    buildFormOptions();
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
  project.dangerous = els.projectForm.elements.dangerous.checked;
  project.confirmBeforeStart = els.projectForm.elements.confirmBeforeStart.checked;

  if (!project.port) delete project.port;

  if (!["exe", "bat", "file", "folder"].includes(project.type)) delete project.path;
  if (!["exe", "bat", "cmd"].includes(project.type)) delete project.cwd;
  if (project.type !== "cmd") delete project.command;
  if (!["url", "cmd", "exe", "bat"].includes(project.type)) delete project.url;
  if (!["exe", "bat"].includes(project.type)) delete project.args;

  return project;
}

async function deleteProject(id) {
  const project = state.projects.find((item) => item.id === id);
  if (!project) return;

  const confirmed = window.confirm("\u786e\u5b9a\u5220\u9664\u9879\u76ee: " + project.name + "\uff1f");
  if (!confirmed) return;

  try {
    const data = await api("/api/config/projects/" + encodeURIComponent(id), { method: "DELETE" });
    state.projects = data.projects || [];
    delete state.statuses[id];
    buildTypeOptions();
    buildFormOptions();
    closeProjectDrawer();
    render();
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
