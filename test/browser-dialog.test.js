const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const ROOT_DIR = path.resolve(__dirname, "..");

test("frontend does not use blocking browser dialogs", () => {
  const source = fs.readFileSync(path.join(ROOT_DIR, "public", "app.js"), "utf8");
  const blockingDialogPattern = /\b(?:window\s*\.\s*)?(?:alert|confirm|prompt)\s*\(/;

  assert.doesNotMatch(source, blockingDialogPattern);
});

test("system dialog exposes the shared accessible structure", () => {
  const source = fs.readFileSync(path.join(ROOT_DIR, "public", "index.html"), "utf8");

  assert.match(source, /<dialog[\s\S]*?id="systemDialog"/);
  assert.match(source, /aria-labelledby="systemDialogTitle"/);
  assert.match(source, /id="systemDialogMessage"/);
  assert.match(source, /id="systemDialogCancel"/);
  assert.match(source, /id="systemDialogConfirm"/);
  assert.match(source, /id="systemDialogInput"/);
});

test("project form exposes role-based console policy", () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(ROOT_DIR, "public", "app.js"), "utf8");

  assert.match(html, /name="hideLauncherConsole"/);
  assert.match(html, /name="showServiceConsoles"/);
  assert.match(html, /name="allowInteractiveConsole"/);
  assert.match(script, /form\.showServiceConsoles\.checked = project\.showServiceConsoles !== false/);
  assert.match(script, /project\.allowInteractiveConsole = els\.projectForm\.elements\.allowInteractiveConsole\.checked/);
});

test("project editing preserves external ownership control and renders explicit owners", () => {
  const script = fs.readFileSync(path.join(ROOT_DIR, "public", "app.js"), "utf8");

  assert.match(script, /if \(existing\?\.externalControl\) project\.externalControl = existing\.externalControl/);
  assert.match(script, /watchdog:\s*"计划任务运行"/);
  assert.match(script, /external:\s*"外部独立运行"/);
});

test("launch progress and logs use persistent inline and drawer surfaces", () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(ROOT_DIR, "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(ROOT_DIR, "public", "styles.css"), "utf8");

  assert.match(html, /<table class="project-table">/);
  assert.match(html, /id="launchLogDrawer"[\s\S]*?aria-labelledby="launchLogTitle"/);
  assert.match(html, /id="launchLogOutput"[\s\S]*?aria-label="启动日志输出"/);
  assert.match(html, /data-log-stream="stdout"/);
  assert.match(html, /data-log-stream="stderr"/);
  assert.match(script, /function renderLaunchRunRow\(/);
  assert.match(script, /project-with-launch-run/);
  assert.match(script, /class="launch-run-body-shell" aria-hidden=/);
  assert.match(script, /aria-controls="launch-run-body-/);
  assert.match(script, /data-run-toggle-label/);
  assert.match(script, /data-run-action="dismiss"/);
  assert.match(script, /run\.exitDescription \|\| run\.exitCode/);
  assert.match(script, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/dismiss/);
  assert.match(script, /new EventSource\(/);
  assert.match(script, /用 Codex 分析/);
  assert.doesNotMatch(script, /Math\.random\(\)\s*\*\s*100/);
  assert.match(styles, /\.project-table\s*\{[\s\S]*?border-collapse:\s*separate/);
  assert.match(styles, /\.launch-run-table-row\s*>\s*td\s*\{[\s\S]*?background:\s*var\(--bg\)/);
  assert.match(styles, /\.launch-run-table-row\.is-collapsed\s+\.launch-run-panel\s*\{[\s\S]*?width:\s*min\(720px,\s*100%\)/);
  assert.match(styles, /\.launch-run-dismiss\s*\{/);
});

test("a partial project offers stop remaining services only when external stopping is permitted", () => {
  const source = fs.readFileSync(path.join(ROOT_DIR, "public", "app.js"), "utf8");
  const renderFunction = source.slice(source.indexOf("function renderTable()"), source.indexOf("function renderLaunchRunRow("));
  for (const allowed of [true, false]) {
    const row = { innerHTML: "", querySelectorAll: () => [] };
    const context = {
      visibleProjects: () => [{id: "partial", name: "Partial project", type: "bat", allowStopExternal: allowed}],
      statusOf: () => ({state: "partial", management: "external", externalPids: [33292], auxiliaryPids: [33292]}),
      els: {projectRows: row}, state: {latestRuns: {}},
      pendingProjectActions: new Map(), pendingProjectAdoptions: new Set(),
      runnableTypes: new Set(["bat"]), tableIcons: {}, statusText: {partial: "部分运行"},
      escapeHtml: (value) => String(value ?? ""),
      renderPidTags: (tags) => tags.map((tag) => tag.label).join(" "),
      renderResourceCell: () => "", shouldShowLaunchRun: () => false,
      renderLaunchRunRow: () => "", bindDragEvents() {}
    };
    vm.runInNewContext(renderFunction + "\nrenderTable();", context);
    assert.match(row.innerHTML, /status-partial/);
    assert.match(row.innerHTML, /部分运行/);
    assert.equal(/data-action="stop"/.test(row.innerHTML), allowed);
    assert.doesNotMatch(row.innerHTML, /data-action="start"|data-action="adopt"/);
    assert.equal((row.innerHTML.match(/33292/g) || []).length, 1);
  }
});
