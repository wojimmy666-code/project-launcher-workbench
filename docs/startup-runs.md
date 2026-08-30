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

### 外部项目必须负责的行为

- 依赖探测、`npm install`、`npm run build`、Prisma/数据库迁移、资源生成和 supervisor 必须留在继承的隐藏控制台中；不要使用 `start`、`cmd /k`、`Start-Job` 或 `CREATE_NEW_CONSOLE`。
- 最终后台服务仅在 `PROJECT_LAUNCHER_SHOW_SERVICE_CONSOLES=1` 时创建一个新的可见控制台；启动器必须保留子进程句柄、等待其退出，并传播退出码。
- 业务交互终端仅在 `PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE=1` 时创建新的可见控制台。
- 后台服务权限不能代替交互权限，交互权限也不能放行安装、构建和迁移窗口。
- GUI 应用按 GUI 方式正常显示，不把 GUI 主窗口当作控制台窗口处理。
- 即使服务或交互终端可见，关键日志仍应追加到 `PROJECT_LAUNCHER_LOG_DIR`；不要只把日志留在控制台。
- 多服务项目应由一个隐藏 supervisor 持有全部服务句柄，分别记录 PID，任一关键服务异常时执行有界清理并返回非零退出码。
- 手动启动分支可以保留原有可见终端，但必须与 `PROJECT_LAUNCHER_MANAGED=1` 的托管分支明确隔离。

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
