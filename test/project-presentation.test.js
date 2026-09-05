const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const presentationSource = [
  section("function renderTable()", "function renderLaunchRunRow("),
  section("function bindDragEvents()", "async function handleAction("),
  section("function settleSystemDialog(", "function showModal(")
].join("\n");

function fixture(id, status = "stopped", favorite = false, category = "tools") {
  return {id, name: id, type: "bat", favorite, category, fixtureStatus: status};
}

function setup(projects = []) {
  const calls = [];
  const toasts = [];
  const scheduled = [];
  const rows = {innerHTML: "", querySelectorAll: () => []};
  const context = {
    state: {
      projects, statuses: {}, latestRuns: {}, selectedCategory: "all",
      search: "", statusFilter: "all", typeFilter: "all", draggingId: null
    },
    CATEGORY_IDS: {all: "all", running: "running", favorite: "favorite"},
    statusOf: (project) => context.state.statuses[project.id] || {state: project.fixtureStatus},
    normalizeCategoryId: (value) => value,
    categoryLabel: (value) => value,
    els: {projectRows: rows, systemDialog: {open: false}}, activeSystemDialog: null,
    projectTableRenderDeferred: false,
    pendingProjectActions: new Map(), pendingProjectAdoptions: new Set(),
    runnableTypes: new Set(["bat"]), tableIcons: {}, statusText: {},
    escapeHtml: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"),
    renderResourceCell: () => "", shouldShowLaunchRun: (run) => Boolean(run),
    renderLaunchRunRow: (project, run) => run ? `<tr class="launch-run-table-row" data-test-run="${project.id}"></tr>` : "",
    showToast: (message) => toasts.push(message),
    api: async (url, options) => {
      calls.push({url, options});
      return {ids: options.body.ids};
    },
    applyConfigData: (data) => {
      context.state.projects = Array.from(data.ids, (id) => context.state.projects.find((project) => project.id === id));
    },
    window: {setTimeout: (fn) => scheduled.push(fn)}
  };
  vm.createContext(context);
  vm.runInContext(presentationSource, context);
  return {context, calls, toasts, rows, scheduled};
}

const ids = (projects) => Array.from(projects, (project) => project.id);
const renderedIds = (rows) => Array.from(rows.innerHTML.matchAll(/data-project-id="([^"]+)"/g), (match) => match[1]);

test("all statuses sort by activity, then favorites, then stable manual order without writes", () => {
  const projects = [
    fixture("idle-favorite", "stopped", true), fixture("failed", "error"),
    fixture("external", "running"), fixture("starting", "starting"),
    fixture("self", "running"), fixture("partial-favorite", "partial", true),
    fixture("running-favorite", "running", true), fixture("conflict", "conflict"),
    fixture("stopping", "stopping"), fixture("alternate", "alternate"),
    fixture("multi", "multi_instance"), fixture("unknown", "unknown"), fixture("idle")
  ];
  const {context, calls} = setup(projects);
  const originalIds = ids(projects);
  const expected = ["running-favorite", "external", "self", "partial-favorite", "starting", "stopping", "alternate", "multi", "failed", "conflict", "idle-favorite", "unknown", "idle"];
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(ids(context.visibleProjects()), expected);
    assert.deepEqual(ids(context.state.projects), originalIds);
  }
  assert.equal(calls.length, 0);
});

test("categories, favorites, search, and status/type filters retain activity priority", () => {
  const {context} = setup([
    fixture("shared-idle", "stopped", true), fixture("shared-running", "running", true),
    fixture("other-category", "running", false, "other"), fixture("tools-active", "partial")
  ]);
  context.state.selectedCategory = "tools";
  assert.deepEqual(ids(context.visibleProjects()), ["shared-running", "tools-active", "shared-idle"]);
  context.state.selectedCategory = "favorite";
  assert.deepEqual(ids(context.visibleProjects()), ["shared-running", "shared-idle"]);
  context.state.selectedCategory = "all";
  context.state.search = "shared";
  assert.deepEqual(ids(context.visibleProjects()), ["shared-running", "shared-idle"]);
  context.state.statusFilter = "stopped";
  assert.deepEqual(ids(context.visibleProjects()), ["shared-idle"]);
  context.state.typeFilter = "exe";
  assert.deepEqual(ids(context.visibleProjects()), []);
});

test("pending start/stop and confirmed status changes update the display without changing configuration", () => {
  const {context, rows, calls} = setup([fixture("idle"), fixture("running", "running")]);
  context.renderTable();
  assert.deepEqual(renderedIds(rows), ["running", "idle"]);
  context.pendingProjectActions.set("idle", {statusState: "starting", action: "start", targetState: "running"});
  assert.equal(context.projectDisplayPriority(context.state.projects[0]), 1);
  context.pendingProjectActions.set("running", {statusState: "stopping", action: "stop", targetState: "stopped"});
  assert.equal(context.projectDisplayPriority(context.state.projects[1]), 1);
  context.pendingProjectActions.clear();
  context.state.statuses = {idle: {state: "running"}, running: {state: "stopped"}};
  context.renderTable();
  assert.deepEqual(renderedIds(rows), ["idle", "running"]);
  assert.deepEqual(ids(context.state.projects), ["idle", "running"]);
  assert.equal(calls.length, 0);
});

test("sections have accurate counts, retain launch rows, and only healthy projects get green emphasis", () => {
  const {context, rows} = setup([fixture("idle"), fixture("partial", "partial"), fixture("healthy", "running"), fixture("failed", "error")]);
  context.state.latestRuns = {healthy: {id: "run-healthy"}, failed: {id: "run-failed"}};
  context.renderTable();
  assert.deepEqual(renderedIds(rows), ["healthy", "partial", "failed", "idle"]);
  assert.equal((rows.innerHTML.match(/class="project-section-row/g) || []).length, 2);
  assert.match(rows.innerHTML, /运行与活动项目<\/span><span class="project-section-count">2 个/);
  assert.match(rows.innerHTML, /未运行项目<\/span><span class="project-section-count">2 个/);
  assert.match(rows.innerHTML, /class="project-row-running project-with-launch-run" data-project-id="healthy"/);
  assert.match(rows.innerHTML, /class="project-row-active" data-project-id="partial"/);
  assert.match(rows.innerHTML, /class="project-row-inactive project-with-launch-run" data-project-id="failed"/);
  const healthy = rows.innerHTML.indexOf('data-project-id="healthy"');
  const healthyRun = rows.innerHTML.indexOf('data-test-run="healthy"');
  const next = rows.innerHTML.indexOf('data-project-id="partial"');
  assert.ok(healthy < healthyRun && healthyRun < next);
  assert.doesNotMatch(rows.innerHTML, /pid-tag|pid-overflow/);
});

test("empty, active-only, and inactive-only lists do not render empty sections", () => {
  for (const [projects, sectionName] of [
    [[], null], [[fixture("running", "running")], "active"], [[fixture("idle")], "inactive"]
  ]) {
    const {context, rows} = setup(projects);
    context.renderTable();
    assert.equal((rows.innerHTML.match(/class="project-section-row/g) || []).length, sectionName ? 1 : 0);
    if (sectionName) assert.ok(rows.innerHTML.includes(`section-${sectionName}`));
    else assert.match(rows.innerHTML, /没有匹配的项目/);
  }
});

test("same-tier drag rewrites only visible peers' slots, preserving hidden and other-tier projects", async () => {
  const {context, calls} = setup([
    fixture("idle"), fixture("first", "running"), fixture("hidden", "running", false, "other"),
    fixture("favorite", "running", true), fixture("failed", "error"), fixture("second", "running")
  ]);
  context.state.selectedCategory = "tools";
  await context.saveProjectOrder("second", "first", false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/config/projects/reorder");
  assert.deepEqual(Array.from(calls[0].options.body.ids), ["idle", "second", "hidden", "favorite", "failed", "first"]);
  assert.deepEqual(ids(context.visibleProjects()), ["favorite", "second", "first", "failed", "idle"]);
});

test("cross-state, cross-favorite, missing, filtered-out, and no-op drags never write configuration", async () => {
  const {context, calls, toasts} = setup([
    fixture("running", "running"), fixture("favorite", "running", true), fixture("idle"),
    fixture("hidden", "running", false, "other")
  ]);
  context.state.selectedCategory = "tools";
  await context.saveProjectOrder("idle", "running", false);
  await context.saveProjectOrder("favorite", "running", false);
  await context.saveProjectOrder("gone", "running", false);
  await context.saveProjectOrder("running", "hidden", false);
  await context.saveProjectOrder("running", "running", false);
  assert.equal(calls.length, 0);
  assert.ok(toasts.some((message) => message.includes("运行优先")));
});

test("a status change during a drag is revalidated before saving", async () => {
  const {context, calls} = setup([fixture("first", "running"), fixture("second", "running")]);
  assert.equal(context.canReorderProjects(...context.state.projects), true);
  context.state.statuses.second = {state: "error"};
  await context.saveProjectOrder("second", "first", false);
  assert.equal(calls.length, 0);
});

test("drag polling preserves the actual table DOM until drag end, then applies the newest order", () => {
  const {context, rows} = setup([fixture("first", "running"), fixture("second")]);
  context.renderTable();
  const original = rows.innerHTML;
  context.state.draggingId = "second";
  context.state.statuses = {first: {state: "stopped"}, second: {state: "running"}};
  context.renderTable();
  assert.equal(rows.innerHTML, original);
  assert.equal(context.projectTableRenderDeferred, true);
  context.resetDragState();
  assert.deepEqual(renderedIds(rows), ["second", "first"]);
  assert.equal(context.projectTableRenderDeferred, false);
});

test("confirmation cancellation releases a deferred table update immediately", () => {
  const {context, rows, scheduled} = setup([fixture("first", "running"), fixture("second")]);
  context.renderTable();
  const original = rows.innerHTML;
  let resolved;
  context.activeSystemDialog = {resolve: (value) => { resolved = value; }};
  context.state.statuses = {first: {state: "error"}, second: {state: "running"}};
  context.renderTable();
  assert.equal(rows.innerHTML, original);
  context.settleSystemDialog(false);
  scheduled.forEach((fn) => fn());
  assert.equal(resolved, false);
  assert.deepEqual(renderedIds(rows), ["second", "first"]);
});

test("in-flight reorder preserves DOM until persistence ends even if native dragend fires", () => {
  const {context, rows} = setup([fixture("first", "running"), fixture("second")]);
  context.renderTable();
  const original = rows.innerHTML;
  context.state.reorderingProjects = true;
  context.state.statuses = {first: {state: "stopped"}, second: {state: "running"}};
  context.renderTable();
  context.resetDragState();
  assert.equal(rows.innerHTML, original);
  context.state.reorderingProjects = false;
  context.renderTable();
  assert.deepEqual(renderedIds(rows), ["second", "first"]);
});

test("confirmation focus returns to the replacement project control after a deferred render", () => {
  const {context, rows, scheduled} = setup([fixture("project", "running")]);
  context.renderTable();
  const focus = [];
  const button = {dataset: {id: "project", action: "stop"}, addEventListener() {}, focus: () => focus.push("stop")};
  rows.querySelectorAll = (selector) => selector === "button[data-action]" ? [button] : [];
  context.activeSystemDialog = {resolve() {}, trigger: {isConnected: false, dataset: button.dataset}};
  context.renderTable();
  context.settleSystemDialog(false);
  scheduled.forEach((fn) => fn());
  assert.deepEqual(focus, ["stop"]);
});

test("native drag handlers reject cross-tier targets and release the render lock after save", async () => {
  const {context, rows, calls, toasts} = setup([fixture("first", "running"), fixture("second", "running")]);
  const node = (dataset) => ({
    dataset, events: {}, classList: {add() {}, remove() {}, toggle() {}, contains: () => false},
    addEventListener(name, callback) { this.events[name] = callback; },
    getBoundingClientRect: () => ({top: 0, height: 80})
  });
  const target = node({projectId: "first"});
  const handle = node({dragId: "second"});
  handle.closest = () => target;
  rows.querySelectorAll = (selector) => selector === "[data-drag-id]" ? [handle] : selector === "tr[data-project-id]" ? [target] : [];
  context.bindDragEvents();
  const event = {preventDefault() {}, clientY: 10, dataTransfer: {setData() {}, getData: () => "second"}};
  handle.events.dragstart(event);
  assert.equal(context.state.draggingId, "second");
  context.state.statuses.first = {state: "stopped"};
  target.events.dragover(event);
  target.events.dragover(event);
  assert.equal(event.dataTransfer.dropEffect, "none");
  assert.equal(toasts.length, 1);
  context.state.statuses.first = {state: "running"};
  target.events.dragover(event);
  assert.equal(event.dataTransfer.dropEffect, "move");
  await target.events.drop(event);
  assert.equal(calls.length, 1);
  assert.equal(context.state.reorderingProjects, false);
  assert.equal(context.state.draggingId, null);
  assert.deepEqual(renderedIds(rows), ["second", "first"]);
});

test("a failed manual reorder reports the failure and preserves the configured order", async () => {
  const {context, toasts} = setup([fixture("first", "running"), fixture("second", "running")]);
  context.api = async () => { throw new Error("save failed"); };
  await context.saveProjectOrder("second", "first", false);
  assert.deepEqual(ids(context.state.projects), ["first", "second"]);
  assert.deepEqual(toasts, ["save failed"]);
});

test("new hierarchy colors preserve readable text contrast without row opacity", () => {
  const luminance = (hex) => {
    const rgb = hex.match(/[a-f0-9]{2}/gi).map((value) => parseInt(value, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  for (const [text, background] of [
    ["183d30", "f0f8f4"], ["456454", "f0f8f4"], ["456454", "e7f3ec"],
    ["526176", "fafbfd"], ["526176", "f0f3f7"], ["526176", "eef2f6"], ["526176", "f4f7fb"],
    ["167454", "ffffff"]
  ]) {
    assert.ok((luminance(background) + 0.05) / (luminance(text) + 0.05) >= 4.5, `${text} on ${background}`);
  }
  const css = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");
  assert.doesNotMatch(css, /\.project-row-inactive[^{}]*\{[^}]*opacity:/);
  assert.match(css, /\.status-stopped\s*\{\s*background: var\(--gray-soft\)/);
  assert.match(css, /\.project-row-running \+ \.launch-run-table-row > td::before/);
  assert.match(css, /\.project-row-running \.resource-sub\s*\{\s*color: #456454/);
  assert.match(css, /\.project-row-inactive \.resource-sub\s*\{\s*color: var\(--project-secondary-text\)/);
});
