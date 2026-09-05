const assert = require("node:assert/strict");
const test = require("node:test");
const {
  WINDOWS_CONTROL_C_EXIT_CODE,
  describeProcessExit,
  isControlInterrupt,
  normalizeProcessExitCode
} = require("../server/process-exit");

test("Windows control interruption is recognized from signed and unsigned status", () => {
  assert.equal(isControlInterrupt(-1073741510), true);
  assert.equal(isControlInterrupt(0xc000013a), true);
  assert.equal(normalizeProcessExitCode(0xc000013a), WINDOWS_CONTROL_C_EXIT_CODE);
  assert.equal(normalizeProcessExitCode(null, "SIGINT"), WINDOWS_CONTROL_C_EXIT_CODE);
  assert.equal(normalizeProcessExitCode(null, "SIGBREAK"), WINDOWS_CONTROL_C_EXIT_CODE);
});

test("process exit descriptions distinguish interruption, numeric exit, and signal", () => {
  assert.equal(
    describeProcessExit(-1073741510),
    "进程被中断（Ctrl+C 或控制台关闭，0xC000013A）"
  );
  assert.equal(describeProcessExit(9), "退出码 9");
  assert.equal(describeProcessExit(null, "SIGTERM"), "信号 SIGTERM");
  assert.equal(describeProcessExit(null, null), "退出状态未知");
});
