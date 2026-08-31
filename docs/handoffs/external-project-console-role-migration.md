# 外部项目 Windows 控制台角色迁移交接

## 1. 任务、目标路径与边界

目标：把管理台托管启动时的 Windows 窗口按“中间过程 / 最终服务 / 业务交互”分流。依赖检查、安装、构建、迁移和 supervisor 保持隐藏；最终后台服务允许显示；业务交互终端仅经独立权限显示。

目标项目及管理台项目 ID：

| 目标项目路径 | 管理台项目 ID | 预计可见窗口 |
| --- | --- | --- |
| `D:\Projects\PolymarketBots` | `Polymarket-Temp`、`Polymarket-TempPath`、`SmartMoney` | 主服务各 1 个；`Polymarket-Temp` 可额外显示 1 个风险交互终端。 |
| `D:\Projects\ViralDna` | `ViralDNA` | API、Web 各 1 个。 |
| `D:\Projects\GoldAlpha` | `gold-alpha` | API、Web 各 1 个。 |
| `D:\Projects\BeautyTraining` | `BeautyTraining` | Next 服务 1 个。 |
| `D:\Projects\MT_Attendance` | `MeiTa-OA` | Next 服务 1 个。 |
| `D:\Projects\recruitment-assistant` | `recruitment-assistant` | Node/tsx 服务 1 个。 |
| `D:\Projects\BeautyHandAILab` | `BeautyHandAILab` | Vite 服务 1 个。 |

每个目标项目的 Codex 只能修改自己的项目路径，不得修改 `D:\Projects\project-launcher-workbench` 或表中其他项目。不得改写已有未提交变更，不得记录 `.env` 中的密码、Token、API Key、Cookie 或其他凭据。管理台代码和配置契约已经完成；外部项目只实现本项目内部的角色启动逻辑与测试。

## 2. 问题现象、影响和复现

复现条件：从项目管理台启动上述项目，且项目配置 `hideLauncherConsole=true`。旧启动链由 Node/libuv 以 detached 方式创建隐藏根 `cmd.exe`，但项目脚本继续创建 Python、Node、PowerShell、`cmd /k` 或 `start` 子进程。子进程可能分配新的 `conhost.exe`，导致一次启动弹出多个 CMD 窗口；如果把全部子控制台一刀切关闭，又会把确实需要显示的服务和风险交互窗口一起隐藏。

影响：

- 安装、构建、迁移等短命窗口频繁闪现，难以判断哪个窗口可关闭。
- 多服务项目会产生启动器、supervisor 和业务服务混杂的窗口。
- `allowChildConsole` 同时承担服务和交互权限，权限含义过宽。
- 单纯关闭 `allowChildConsole` 会破坏 `Polymarket-Temp` 的风险交互终端。

验收复现至少覆盖：依赖已安装与缺失、无需构建与需要构建、端口空闲与占用、手动双击启动、管理台托管启动、停止后重新启动、多实例策略启动。

## 3. 根因、调用链与证据

管理台已确认的根因是“隐藏根窗口”不能自动表达子进程角色。新管理台使用隐藏的 Win32 托管宿主，使普通后代继承一个真实但不可见的控制台；因此外部项目必须仅对最终服务或业务交互显式申请新控制台。

现有调用链证据：

- `D:\Projects\PolymarketBots\strategy\temperature\run_trader.bat:17-19` 探测 Python，随后直接运行交易主进程；`mode1_risk_service\launcher.py:18,32-35,224` 根据旧 `PROJECT_LAUNCHER_ALLOW_CHILD_CONSOLE` 使用 `CREATE_NEW_CONSOLE`。主服务与风险交互尚未分权。
- `D:\Projects\PolymarketBots\strategy\temperature_path\scripts\start_server.bat:14-49` 完成 Python 探测后直接运行 `analysis_lab.cli`。`scripts\start.bat:121,156` 另有 `start ... cmd /k` 手动分支，不得进入托管链。
- `D:\Projects\PolymarketBots\strategy\smart_money\scripts\start_server.bat:9-23` 探测 Python 后直接运行服务。
- `D:\Projects\ViralDna\scripts\start.bat:40,91,96,127,190` 将托管分支路由到 `managed-launcher.mjs`，手动分支使用两个 `start ... cmd /k`；`managed-launcher.mjs:44` 当前把 API 和 Web 都设为 `windowsHide:true`。
- `D:\Projects\GoldAlpha\scripts\start.bat:11` 调用 `managed-launcher.mjs`；该文件 `createServicePlan` 定义 API/Web，`createSpawnOptions` 在约第 80 行使用 `windowsHide: managed`。
- `D:\Projects\BeautyTraining\scripts\launchers\start-local-test.bat:21,30` 执行安装和构建，`47-54` 在托管分支直接运行 `scripts\workers\pm2-start.mjs`；后者直接创建 Next 子进程并等待。
- `D:\Projects\MT_Attendance\scripts\start-local-test.bat:11-36` 校验依赖并直接运行 Next；`scripts\start-server.bat:48,97` 还包含安装和 `npm.cmd run start` 链。
- `D:\Projects\recruitment-assistant\scripts\start-server.bat:12-39` 依次检查 Node/npm/依赖后执行 `npm run start`。
- `D:\Projects\BeautyHandAILab\script\start-local-test.bat:10-44` 检查 Node/npm、按需安装、校验资源，再执行 `npm run dev`。

这些文件均是只读审计所得；本交接没有修改任何外部项目。

## 4. 管理台接口契约

托管启动时必须读取以下环境变量：

| 环境变量 | 含义 |
| --- | --- |
| `PROJECT_LAUNCHER_MANAGED=1` | 当前处于管理台托管分支。 |
| `PROJECT_LAUNCHER_HIDE_INTERMEDIATE_CONSOLES=1|0` | 安装、构建、迁移、探测和 supervisor 是否隐藏。 |
| `PROJECT_LAUNCHER_SHOW_SERVICE_CONSOLES=1|0` | 最终长驻服务是否允许可见。 |
| `PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE=1|0` | 业务交互终端是否允许可见。 |
| `PROJECT_LAUNCHER_ROLE_RUNNER` | 管理台提供的角色运行器绝对路径。 |
| `PROJECT_LAUNCHER_PROCESS_HOST` | 角色运行器内部使用的 Win32 宿主路径；项目通常不应直接调用。 |
| `PROJECT_LAUNCHER_RUN_ID` | 本次启动 ID。 |
| `PROJECT_LAUNCHER_EVENT_FILE` | 可追加 NDJSON 阶段事件的文件。 |
| `PROJECT_LAUNCHER_LOG_DIR` | 本次启动的日志目录。 |

兼容期内，`PROJECT_LAUNCHER_ALLOW_CHILD_CONSOLE` 与新交互权限保持同值。新代码应优先读 `PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE`，仅在新变量不存在时回退旧变量。

推荐调用格式：

```bat
node "%PROJECT_LAUNCHER_ROLE_RUNNER%" service --cwd "%PROJECT_ROOT%" -- "%PYTHON_EXE%" -m package.server
```

```js
const child = spawn(process.execPath, [
  process.env.PROJECT_LAUNCHER_ROLE_RUNNER,
  "service",
  "--cwd", service.cwd,
  "--",
  service.command,
  ...service.args,
], {
  cwd: service.cwd,
  env: process.env,
  shell: false,
  detached: false,
  windowsHide: true,
  stdio: "inherit",
});
```

角色运行器等待目标进程并传播真实退出码。`service` 权限关闭时自动降级为隐藏运行；`interactive` 未授权时拒绝启动。不要把 `npm.cmd`、`.bat` 或任意拼接命令行直接作为目标可执行文件；优先使用 Python/Node 可执行文件和对应模块入口，避免二次 `cmd.exe`。

日志必须继续写入 `PROJECT_LAUNCHER_LOG_DIR`。可见控制台不是日志存储。项目自定义阶段继续按一行一个 UTF-8 JSON 对象追加到 `PROJECT_LAUNCHER_EVENT_FILE`，不得写敏感环境变量。

## 5. 分项目修改方案

### 5.1 PolymarketBots

建议修改：

- `strategy/temperature/run_trader.bat`：保留 Python 探测、参数校验和失败处理在隐藏启动链；仅在真正执行 `statarb_advisor.py` 时，托管分支通过角色运行器以 `service` 启动并 `exit /b` 传播退出码。手动分支继续直接运行并按原策略 `pause`。
- 角色运行器必须让最终 Python 服务使用独立服务控制台。关闭该服务窗口时，中断事件不能传回隐藏的外层 BAT，否则 `cmd.exe` 会按 CP936 输出“终止批处理操作吗(Y/N)?”并产生 `0xC000013A`。
- `strategy/temperature/mode1_risk_service/launcher.py`：新增纯函数解析交互权限，优先 `PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE`，缺失时回退 `PROJECT_LAUNCHER_ALLOW_CHILD_CONSOLE`。只有风险服务确属交互窗口且权限为 `1` 时使用 `CREATE_NEW_CONSOLE`；不得因为 `SHOW_SERVICE_CONSOLES=1` 放行风险交互。
- `strategy/temperature/unit_test/test_mode1_risk_service.py`：把现有旧变量用例扩展为新变量优先级、旧变量回退、两者冲突时新变量优先、未托管手动启动兼容。
- `strategy/temperature_path/scripts/start_server.bat`：探测 Python和目录准备保持隐藏；最终 `analysis_lab.cli --serve --host ... --port ...` 改由 `service` 角色运行器启动并等待。不要复用 `scripts/start.bat` 中 `start ... cmd /k` 的手动逻辑。
- `strategy/smart_money/scripts/start_server.bat`：同样只包装最终 Python 服务；Python 探测和错误提示留在隐藏链。
- 为三个 BAT 增加静态契约测试，断言托管分支存在 `PROJECT_LAUNCHER_ROLE_RUNNER`、`service` 和 `--cwd`，且托管分支没有 `start`、`cmd /k`、`CREATE_NEW_CONSOLE`。

预期：`Polymarket-Temp` 主交易服务显示 1 个服务窗口；风险模式启用且交互权限为 `1` 时再显示 1 个风险窗口。`Polymarket-TempPath`、`SmartMoney` 各显示 1 个服务窗口。

### 5.2 ViralDna

建议修改：

- `scripts/managed-launcher.mjs`：保留自身作为隐藏 supervisor。`createServicePlan` 继续使用 Python/Node 直接入口；托管时实际 spawn 的命令改为 `process.execPath + PROJECT_LAUNCHER_ROLE_RUNNER + service + 原始命令`。不要把 API/Web 直接设为 detached，也不要再依赖 `windowsHide:true` 表达服务角色。
- `stopAll` 必须终止每个角色运行器的完整进程树，而不只是 `child.kill()` 结束中间 Node。Windows 可对已校验的角色运行器 PID 使用 `taskkill /PID <pid> /T /F`；只允许处理本 supervisor 创建并持有句柄的 PID。
- `scripts/start.bat`：安装和依赖检查继续在托管隐藏分支执行；`start ... cmd /k` 仅保留在非托管手动分支。
- `scripts/managed-launcher.test.mjs`：断言托管模式 API/Web 均通过 `service` 角色运行器，`shell:false`、`detached:false`，原始命令和参数保持数组边界；验证任一服务失败时清理另一服务树并返回非零。

### 5.3 GoldAlpha

建议修改：

- `scripts/managed-launcher.mjs`：与 ViralDna 相同，隐藏 supervisor 持有两个角色运行器，API/Web 的原始直接入口分别作为 `service` 目标。手动模式保留原有可见行为。
- 现有 `windowsHide: managed` 只能控制直接子进程，不再作为服务可见性判断；服务权限完全交给角色运行器。
- 完善退出联动和进程树清理，防止 API 失败后 Web 留存或反向留存。
- `scripts/managed-launcher.test.mjs`：新增角色包装、权限关闭时仍可隐藏运行、退出码传播、双服务清理、命令参数无 shell 拼接等用例。

### 5.4 BeautyTraining

建议修改：

- `scripts/launchers/start-local-test.bat`：`npm install` 和 `npm run build` 必须直接留在隐藏启动 BAT 中；托管分支的最后一步改为角色运行器以 `service` 启动 `node scripts/workers/pm2-start.mjs`。非托管分支可继续使用现有可见方式。
- `scripts/workers/pm2-start.mjs`：保持为可见服务窗口内的前台 supervisor，继续等待 Next 子进程并传播退出码。将 Next stdout/stderr 同时输出到当前控制台并追加到 `PROJECT_LAUNCHER_LOG_DIR` 下的项目日志，日志写入失败只能告警，不能使服务退出。
- 不要在托管分支切换为 PM2 daemon；否则管理台无法可靠跟踪服务生命周期和退出码。
- 新增针对 BAT 分流和 `pm2-start.mjs` 日志/退出传播的 Node 测试。

### 5.5 MT_Attendance

建议修改：

- `scripts/start-local-test.bat`：依赖检查、Prisma、构建均保持隐藏；最终不要通过 `npm.cmd` 二次进入 CMD，改用角色运行器启动 `node node_modules\next\dist\bin\next start --port 3002`。
- `scripts/start-server.bat`：如果仍是受支持入口，同步相同角色规则；安装、构建和迁移不得使用服务权限。
- 为托管分支增加静态测试：最终命令只有一个 `service` 角色，前置 `npm`/Prisma/构建没有 `start` 或 `cmd /k`，退出码逐层传播。

### 5.6 recruitment-assistant

建议修改：

- `scripts/start-server.bat`：Node/npm/依赖检查保持隐藏。最终服务不要调用 `npm run start`，改用角色运行器启动稳定的 Node 入口；可先执行 `npm run build:server` 后启动 `node build/server/index.mjs`，或直接以 `node` 启动项目已确认可用于生产/本地托管的入口。目标入口选择必须由项目现有测试确认。
- 托管分支不得 `pause`，不得 `start` 或 `cmd /k`；手动分支可保留交互提示。
- 新增启动脚本契约测试，并运行 TypeScript 类型检查。

### 5.7 BeautyHandAILab

建议修改：

- `script/start-local-test.bat`：Node/npm 探测、按需 `npm install`、`assets:verify` 均保持隐藏。最终 Vite 服务避免 `npm run dev` 二次 CMD，改由角色运行器调用 `node node_modules\vite\bin\vite.js`，并保留 `--no-open` 对应的不自动打开浏览器行为。
- 托管模式只出现 1 个 Vite 服务窗口；依赖安装和资源校验失败直接返回非零，不能弹出额外窗口或 `pause`。
- 增加脚本契约测试，并覆盖有/无 `node_modules`、`--check`、`--no-open`。

## 6. 必须覆盖的边界情况

- 正常路径：依赖齐全、构建成功、端口就绪，窗口数符合上表。
- 失败路径：缺少 Node/Python、依赖安装失败、构建/迁移失败、服务进程秒退；只显示管理台失败状态和日志，不残留中间窗口或孤儿服务。
- 手动启动：未设置 `PROJECT_LAUNCHER_MANAGED` 时保持项目原有可见终端和 `pause` 行为。
- 托管启动：所有前置阶段隐藏，只有最终服务按 `SHOW_SERVICE_CONSOLES` 显示。
- 权限关闭：`SHOW_SERVICE_CONSOLES=0` 时服务仍启动但保持隐藏；`ALLOW_INTERACTIVE_CONSOLE=0` 时交互终端不得创建。
- 多实例：`Polymarket-Temp` 每个实例只拥有自己的主服务和可选风险窗口；停止一个实例不得影响其他实例。
- 多服务：ViralDna/GoldAlpha 任一关键服务退出时，supervisor 有界清理同实例其他服务并返回非零。
- 停止：管理台停止后，角色运行器、PowerShell 宿主、最终服务及其子进程全部退出，端口释放；不得只关闭可见窗口而留下后台进程。
- 路径：项目路径和 Node/Python 路径含空格时参数边界保持正确，不使用字符串拼接进入 shell。

## 7. 测试命令与验收标准

各项目 Codex至少运行本项目适用命令：

```powershell
# PolymarketBots
py -3.11 -m unittest strategy.temperature.unit_test.test_mode1_risk_service
py -3.11 -m pytest strategy/temperature_path/tests/configuration/test_python_runtime_startup_contract.py

# ViralDna
npm run test:launcher

# GoldAlpha
npm run test:launcher
npm test

# BeautyTraining
npm run encoding:check
npx tsc --noEmit
npm run test:unit
npm run build

# MT_Attendance
npx tsc --noEmit
npm run build

# recruitment-assistant
npm run typecheck
npm run build
npm run build:server

# BeautyHandAILab
npm run typecheck
npm test
npm run build
```

手工验收由管理台逐项目执行：启动期间安装/构建/迁移窗口数量为 0；最终服务窗口数量符合上表；管理台自身窗口数量为 0；服务窗口关闭或进程退出后管理台能得到真实退出结果；点击停止后 5 秒内端口和该实例进程树清空；启动失败记录可在界面关闭。

## 8. 风险和防护

- 安全风险：不得把用户输入拼接到 `cmd /c`；使用角色运行器的参数数组。不得把环境变量整体写日志。
- 数据风险：构建、Prisma 和迁移逻辑只改变窗口归类，不改变执行顺序、数据库参数或自动确认选项。
- 进程归属风险：只终止当前 supervisor 创建并保存 PID/句柄的角色运行器树；不得按进程名全局杀 Node/Python。
- 孤儿进程风险：supervisor 收到失败或停止时必须清理完整后代树；清理超时应记录 PID 和失败原因并返回非零。
- 日志风险：可见服务仍写 `PROJECT_LAUNCHER_LOG_DIR`，设置合理轮转或沿用管理台 Launch Run 保留策略。
- 兼容风险：新环境变量优先、旧变量只回退；未托管手动启动不依赖管理台路径。
- 路径风险：`PROJECT_LAUNCHER_ROLE_RUNNER` 是绝对路径，调用前校验存在；缺失时给出明确错误并退出，不静默退回不受控 `start`。

## 9. 回滚、联调与回传

回滚应逐项目撤销角色包装，恢复原直接启动入口；不要回滚业务依赖、数据库或构建产物。管理台侧可临时将单个项目 `hideLauncherConsole=false` 恢复旧可见启动链，但这只是应急手段，会重新显示中间窗口。

联调顺序：先合入并测试单项目启动器；再从管理台以 `SHOW_SERVICE_CONSOLES=0` 验证隐藏服务；随后改为 `1` 验证可见服务；最后单独验证交互权限、多实例和停止清理。不要并发修改管理台契约。

完成后必须回传：

1. 实际修改文件清单和关键行为说明。
2. 自动化测试命令、退出码和结果摘要。
3. 手工托管启动的实际窗口数量、PID/端口清理结果。
4. 未解决风险或兼容项。
5. 目标项目 commit SHA。
