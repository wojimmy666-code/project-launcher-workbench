const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

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

test("project form exposes explicit child-console permission", () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(ROOT_DIR, "public", "app.js"), "utf8");

  assert.match(html, /name="allowChildConsole"/);
  assert.match(script, /form\.allowChildConsole\.checked = Boolean\(project\.allowChildConsole\)/);
  assert.match(script, /project\.allowChildConsole = els\.projectForm\.elements\.allowChildConsole\.checked/);
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
  assert.match(script, /new EventSource\(/);
  assert.match(script, /用 Codex 分析/);
  assert.doesNotMatch(script, /Math\.random\(\)\s*\*\s*100/);
  assert.match(styles, /\.project-table\s*\{[\s\S]*?border-collapse:\s*separate/);
  assert.match(styles, /\.launch-run-table-row\s*>\s*td\s*\{[\s\S]*?background:\s*var\(--bg\)/);
  assert.match(styles, /\.launch-run-table-row\.is-collapsed\s+\.launch-run-panel\s*\{[\s\S]*?width:\s*min\(720px,\s*100%\)/);
});
