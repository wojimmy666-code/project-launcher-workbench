# 启动任务、进度与进程窗口契约

项目管理台会为每次 `start` / `restart` 创建独立的 Launch Run。HTTP 请求立即返回 `202` 和 `runId`，启动确认在后台继续执行。

## 通用阶段

所有可运行项目自动获得以下阶段：

1. 校验配置。
2. 检查端口和现有实例。
3. 创建启动进程。
4. 等待进程。
5. 等待主端口和辅助端口。
6. 校验端口归属。
7. 记录启动成功或失败。

界面显示真实阶段和耗时，不伪造完成百分比。只有项目本身知道确定总工作量时，才应上报数值进度。

## 项目自定义阶段

管理台启动项目时会注入：

- `PROJECT_LAUNCHER_RUN_ID`：本次启动任务 ID。
- `PROJECT_LAUNCHER_EVENT_FILE`：可追加写入的 NDJSON 事件文件。
- `PROJECT_LAUNCHER_LOG_DIR`：本次启动日志目录。
- `PROJECT_LAUNCHER_MANAGED=1`：进程由管理台托管。

项目可以向 `PROJECT_LAUNCHER_EVENT_FILE` 追加一行 JSON：

```json
{"type":"stage","stage":"database_migration","label":"迁移数据库","message":"正在应用 3 个迁移"}
```

约束：

- `type` 必须是 `stage`。
- `stage` 是项目内稳定的英文标识。
- `label` 是界面显示的简短阶段名。
- `message` 是可选说明。
- 每个事件独占一行，使用 UTF-8 追加写入，不覆盖文件。
- 上报失败不能阻止项目启动。
- 事件不得包含密码、Token、API Key、Cookie 或完整环境变量。

## Windows 进程窗口角色

管理台不再使用一个总开关控制所有控制台窗口，而是使用三个独立角色：

| 配置字段 | 环境变量 | 作用 |
| --- | --- | --- |
| `hideLauncherConsole` | `PROJECT_LAUNCHER_HIDE_INTERMEDIATE_CONSOLES=1|0` | 隐藏启动外壳及依赖检查、安装、构建、迁移、supervisor 等中间过程。 |
| `showServiceConsoles` | `PROJECT_LAUNCHER_SHOW_SERVICE_CONSOLES=1|0` | 允许最终长驻后台服务创建可见控制台。项目必须显式把目标进程标记为服务角色。 |
| `allowInteractiveConsole` | `PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE=1|0` | 允许确实需要用户观察或输入的业务交互终端。 |

管理台还注入 `PROJECT_LAUNCHER_ROLE_RUNNER` 和 `PROJECT_LAUNCHER_PROCESS_HOST`。外部项目优先调用角色运行器，不要自行复制 Win32 窗口创建代码：

```bat
node "%PROJECT_LAUNCHER_ROLE_RUNNER%" service --cwd "%CD%" -- "%PYTHON_EXE%" -m package.server
```

角色运行器会等待目标进程并传播退出码。`service` 在服务窗口权限关闭时自动降级为隐藏运行；`interactive` 在交互权限未授权时拒绝启动。

兼容规则：

- 旧字段 `hideConsole` 自动迁移为 `hideLauncherConsole`，保存配置时两者保持一致。
- 旧字段 `allowChildConsole` 自动迁移为 `allowInteractiveConsole`，保存配置时两者保持一致。
- 旧环境变量 `PROJECT_LAUNCHER_ALLOW_CHILD_CONSOLE` 暂时继续注入，并与 `PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE` 保持一致。
- 未配置 `showServiceConsoles` 的旧项目默认视为 `true`；管理台自身显式配置为 `false`。

### 管理台负责的行为

当 `hideLauncherConsole=true` 时，Windows 管理台通过 `scripts/managed-process-host.ps1` 创建启动进程。该进程获得一个真实但不可见的独立控制台，普通子进程继承这个隐藏控制台，因此不会因 Node/libuv 的 detached 行为反复弹出 `cmd` 或 `conhost` 窗口。stdout、stderr、真实退出码、进程树和停止行为仍由管理台记录和跟踪。

托管宿主外层的 `powershell.exe` 必须以 `detached=false` 启动并调用 `unref()`；不能复用普通项目的强制 detached 启动器。部分 Windows/Node 组合会让 detached PowerShell 忽略 `-File` 或 `-Command` 后直接以 `0` 退出。真正的独立进程组和控制台由宿主内部的 Win32 `CreateProcessW` 创建，因此外层 PowerShell 无需 detached。

创建启动进程前必须检查 `port` 和全部 `auxiliaryPorts`。主端口已由同项目完整实例监听时可以识别为“已运行”；辅助端口只要被当前托管实例之外的进程占用，就必须在 spawn 前返回 `PROJECT_PORT_CONFLICT`，不能先启动其他服务再等待归属核验失败。

### 外部项目必须负责的行为

- 依赖探测、`npm install`、`npm run build`、Prisma/数据库迁移、资源生成和 supervisor 必须留在继承的隐藏控制台中；不要使用 `start`、`cmd /k`、`Start-Job` 或 `CREATE_NEW_CONSOLE`。
- 最终后台服务仅在 `PROJECT_LAUNCHER_SHOW_SERVICE_CONSOLES=1` 时创建一个新的可见控制台；启动器必须保留子进程句柄、等待其退出，并传播退出码。
- 业务交互终端仅在 `PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE=1` 时创建新的可见控制台。
- 后台服务权限不能代替交互权限，交互权限也不能放行安装、构建和迁移窗口。
- GUI 应用按 GUI 方式正常显示，不把 GUI 主窗口当作控制台窗口处理。
- 即使服务或交互终端可见，关键日志仍应追加到 `PROJECT_LAUNCHER_LOG_DIR`；不要只把日志留在控制台。
- 多服务项目应由一个隐藏 supervisor 持有全部服务句柄，分别记录 PID，任一关键服务异常时执行有界清理并返回非零退出码。
- 手动启动分支可以保留原有可见终端，但必须与 `PROJECT_LAUNCHER_MANAGED=1` 的托管分支明确隔离。

## 多服务项目的部分运行与进程匹配

`port` 与 `auxiliaryPorts` 都参与状态检查和停止发现。任一已确认归属的服务仍在监听、其他必需端口未就绪时，状态为 `partial`（部分运行）；启动确认期间仍显示 `starting`。全部端口就绪才能显示完整运行。旧的“已手动停止”记录不能覆盖当前监听证据。

`partial` 返回 `readyPorts`、`missingPorts` 和包含辅助服务的 `externalPids`。界面提供“停止剩余服务”，沿用 `allowStopExternal` 权限；不允许把不完整服务组当成完整实例接管。停止完成后再完整启动。未知或其他项目占用辅助端口时显示冲突，不会自动关闭它；主端口专用关闭按钮不能操作辅助端口。

`processMatch` 始终是 **AND**：数组中的所有特征必须在同一进程中出现。不要把“项目路径”和“独立模块名”当成两个备选条件塞入同一数组。绝对项目启动路径仍由现有路径规则匹配。对多个独立业务服务，可额外配置 `processMatchGroups`：每组内部 AND，组之间 OR，与原 `processMatch` 互为备选，例如：

```json
{
  "processMatch": ["statarb_advisor.py"],
  "processMatchGroups": [["-m strategy.temperature.mode1_risk_service"]]
}
```

分组只使用能区分项目的模块/脚本特征。不能以 `python.exe`、`node.exe`、`next` 或端口号单独建立停止归属。空组和无效组整体丢弃，避免删掉条件后扩大匹配范围。当前编辑表单保留此高级字段。

2026-09-05 全项目检查与恢复记录见 [项目进程归属检查](project-process-ownership-audit-2026-09-05.md)。

## 双入口单实例与外部所有权控制

同一服务需要同时支持管理台和计划任务/手动脚本时，可以配置可选的 `externalControl`。未配置时完全沿用原来的端口、PID和通用 `taskkill` 行为。

```json
{
  "externalControl": {
    "command": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "cwd": "D:\\Projects\\ExampleProject",
    "stateFile": "%LOCALAPPDATA%\\ExampleProject\\service-control\\desired-state.json",
    "args": ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "D:\\Projects\\ExampleProject\\scripts\\service-control.ps1"],
    "timeoutMs": 15000,
    "actions": {
      "prepareManagedStart": ["prepare-managed-start"],
      "managedStarted": ["managed-started"],
      "managedStartFailed": ["managed-start-failed"],
      "prepareManagedStop": ["prepare-managed-stop"],
      "stopExternal": ["stop-external"],
      "prepareAdopt": ["prepare-adopt"]
    }
  }
}
```

契约要求：

- `command` 和 `cwd` 必须使用绝对路径；`stateFile` 可使用绝对路径或以 `%LOCALAPPDATA%\\` 开头。命令以 `shell=false`、隐藏窗口执行。
- 管理台把 `externalControl.args` 与对应动作参数按数组拼接，不执行字符串命令或 shell 插值。
- 控制动作非零退出或超时会中止当前管理操作。`stopExternal` 配置后，管理台不再对外部 PID 直接执行通用 `taskkill`；项目控制器必须先写停止意图、抑制 watchdog、安全停止服务并等待端口释放。
- `prepareManagedStart` 在创建业务进程前调用；`managedStarted` 在端口和进程归属确认后调用；失败时调用 `managedStartFailed` 回滚所有权。
- `prepareManagedStop` 必须先把期望状态写为停止，管理台随后才结束已跟踪进程，防止 watchdog 抢先重启。
- `prepareAdopt` 必须先把外部 watchdog 切为待命并转移所有权；成功后管理台才持久化接管 PID。

每个动作都会收到：

- `PROJECT_LAUNCHER_CONTROL_ACTION`：当前动作名。
- `PROJECT_LAUNCHER_CONTROL_CONTEXT`：UTF-8 JSON，字段包括 `owner`、`instanceId`、`runId`、`launcherPid`、`ports`、`pids`、`sources`、进程创建时间和命令指纹。
- `PROJECT_LAUNCHER_PROJECT_ID` 和 `PROJECT_LAUNCHER_MANAGED=1`。

状态文件只用于展示和协调，不作为终止进程的唯一依据。格式：

```json
{
  "version": 1,
  "desired": "running",
  "owner": "watchdog",
  "autoRestart": true,
  "runId": "watchdog-20260831",
  "updatedAt": "2026-08-31T14:00:00Z"
}
```

`owner` 只允许 `workbench`、`external`、`watchdog`、`stopped`；`desired` 只允许 `running`、`stopped`。管理台读取有效状态后会把普通“外部启动”细分为“外部独立运行”或“计划任务运行”。状态文件损坏、缺失或版本不支持时降级为普通外部检测。任何停止操作仍需重新验证监听PID、创建时间、命令指纹和端口归属，不能只相信状态文件中的 PID。

### 日志编码兼容

- `stdout.log` 和 `stderr.log` 保留项目写入的原始字节；裁剪时不提前按 UTF-8 改写。
- 管理台生成 `combined.log` 时逐行严格校验 UTF-8，校验失败才按 Windows `GB18030` 解码，再统一写成 UTF-8。
- 读取已完成的旧任务时，如果 `combined.log` 已含替换字符 `�`，管理台会从原始 stdout/stderr 重建可读内容，并把旧文件保留为 `combined.log.encoding-backup`。
- Windows 状态 `0xC000013A` 或 `SIGINT` 显示为“进程被中断（Ctrl+C 或控制台关闭）”，同时保留原始数值退出码供诊断。

## 运行目录与保留策略

默认目录：

```text
%LOCALAPPDATA%\ProjectLauncherWorkbench\runs\<projectId>\<runId>\
```

每次启动包含：

- `summary.json`：任务摘要和最终结果。
- `events.ndjson`：通用阶段和项目自定义阶段。
- `stdout.log`：标准输出。
- `stderr.log`：标准错误。
- `combined.log`：供界面查看的合并输出。
- `diagnostic.md`：失败后生成的 Codex 诊断材料。

默认每个项目保留最近 20 次或 14 天内的记录；单次日志总预算约 20 MB，超过时保留尾部。
