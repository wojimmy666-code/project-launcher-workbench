const WINDOWS_CONTROL_C_EXIT_CODE = -1073741510;
const WINDOWS_CONTROL_C_STATUS = 0xc000013a;

function normalizeProcessExitCode(value, signal = null) {
  if (value !== null && value !== undefined && value !== "") {
    const code = Number(value);
    if (Number.isInteger(code)) {
      return isControlInterrupt(code, signal) ? WINDOWS_CONTROL_C_EXIT_CODE : code;
    }
  }
  return isControlInterrupt(value, signal) ? WINDOWS_CONTROL_C_EXIT_CODE : null;
}

function isControlInterrupt(value, signal = null) {
  const normalizedSignal = String(signal || "").trim().toUpperCase();
  if (["SIGINT", "SIGBREAK"].includes(normalizedSignal)) return true;
  const code = Number(value);
  return Number.isInteger(code) && (code >>> 0) === WINDOWS_CONTROL_C_STATUS;
}

function describeProcessExit(value, signal = null) {
  const code = normalizeProcessExitCode(value, signal);
  if (isControlInterrupt(code, signal)) {
    return "进程被中断（Ctrl+C 或控制台关闭，0xC000013A）";
  }
  if (code !== null) return `退出码 ${code}`;
  const normalizedSignal = String(signal || "").trim();
  if (normalizedSignal) return `信号 ${normalizedSignal}`;
  return "退出状态未知";
}

module.exports = {
  WINDOWS_CONTROL_C_EXIT_CODE,
  describeProcessExit,
  isControlInterrupt,
  normalizeProcessExitCode
};
