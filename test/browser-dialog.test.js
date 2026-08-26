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
