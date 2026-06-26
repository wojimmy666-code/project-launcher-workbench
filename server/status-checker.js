const net = require("node:net");

const STARTING_WINDOW_MS = 30000;

async function checkProjectStatus(project, runtimeState) {
  if (Number.isInteger(project.port)) {
    const open = await isPortOpen(project.host || "127.0.0.1", project.port);
    if (open) {
      return status("running", "端口可访问");
    }

    if (runtimeState?.running) {
      const age = Date.now() - runtimeState.startedAt;
      if (age < STARTING_WINDOW_MS) {
        return status("starting", "进程已启动，等待端口响应");
      }
      return status("error", "进程存在，但端口未响应");
    }

    if (runtimeState?.exitCode && runtimeState.exitCode !== 0) {
      return status("error", `进程异常退出，退出码 ${runtimeState.exitCode}`);
    }

    return status("stopped", "端口未响应");
  }

  if (runtimeState?.running) {
    return status("running", "由工作台启动的进程仍在运行");
  }

  if (runtimeState?.exitCode && runtimeState.exitCode !== 0) {
    return status("error", `进程异常退出，退出码 ${runtimeState.exitCode}`);
  }

  if (runtimeState?.exitedAt) {
    return status("stopped", "进程已退出");
  }

  return status("unknown", "未配置端口或进程检测方式");
}

function isPortOpen(host, port, timeout = 750) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function status(state, message) {
  return {
    state,
    message,
    checkedAt: new Date().toISOString()
  };
}

module.exports = {
  checkProjectStatus,
  isPortOpen
};
