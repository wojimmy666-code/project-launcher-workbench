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

### 3.1 2026-08-31 管理台侧复核结果

角色窗口功能上线后的首次只读复核覆盖管理台全部 11 个可运行项目。当时 9 个隐藏 BAT 项目的启动器均尚未调用 `PROJECT_LAUNCHER_ROLE_RUNNER`；后续 `Polymarket-TempPath` 已开始进行外部项目侧迁移，但首次接入把裸命令 `py` 作为 Win32 可执行文件传入，仍未完成可用闭环。其余项目也必须按本交接逐一实现和验收，不能仅以管理台已经注入角色环境变量判断迁移完成。

| 项目 | 复核结论 | 后续要求 |
| --- | --- | --- |
| `v2rayN` | 直接启动可见 EXE，不经过隐藏 BAT，中间窗口风险低。 | 保持现状，回归启动/停止即可。 |
| `Polymarket-Temp` | 仍是隐藏 BAT 直接启动 Python；历史运行出现过 Windows `0xC000013A`/批处理 Ctrl+C 中断提示。 | 按 5.1 拆分 `service` 与 `interactive`，重点验证多实例和风险交互窗口。 |
| `Polymarket-TempPath` | 前三次托管启动均在外层以 `0` 提前退出；管理台已通过非 detached 宿主修复该问题，Run `20260831083209-6f7cc07b` 曾成功监听 `127.0.0.1:8023`。外部项目随后接入 `service` 角色，但 Run `20260831103604-c3ed63ce` 又以 `255` 失败：Python 和网络预检均通过，`service-stderr.log` 为 `Cannot create managed project process`，端口 `8023` 未监听。隔离对比证明裸命令 `py -3.11` 返回 `255`，而绝对路径 `C:\Windows\py.exe -3.11` 返回 `0`。 | 按 5.1.1 把 Python 可执行文件绝对路径与前缀参数拆开；角色运行器的 `--` 后第一个参数必须是可直接传给 `CreateProcessW` 的 EXE 路径。 |
| `ViralDNA` | Run `20260831085351-84a68d10` 因孤儿 API PID `39736` 占用辅助端口 `8000` 而失败；管理台当时只预检主端口 `4174`，直到归属核验才发现冲突。管理台现已在 spawn 前检查全部辅助端口，并增加 `viral_dna_api.main:app` 匹配特征。清理孤儿进程后，Run `20260831091136-c4a95c23` 在 21.8 秒内成功，Vite PID `32488` 监听 `4174`、Uvicorn PID `41588` 监听 `8000`，两者均归属本次托管树。`managed-launcher.mjs` 仍对 API/Web 使用 `windowsHide:true`，所以服务窗口角色尚未实现。 | 按 5.2 用角色运行器包装两个最终服务，并验证其中一个异常退出时清理另一个。 |
| `gold-alpha` | 原管理台配置 `startupTimeoutMs=0` 会在启动器尚未证明端口就绪时产生假成功；管理台侧已改为 `60000`。外部 API/Web 仍未使用角色运行器。 | 按 5.3 迁移两个服务；必须同时证明 `5173`、`8110` 就绪。 |
| `project-launcher-workbench` | 管理台自身使用直接 CMD 服务入口，不属于外部项目迁移范围。 | 仅做管理台回归，不在任何外部仓库修改。 |
| `BeautyTraining` | 上线后没有新的实际托管启动证据；静态链仍包含安装、构建、PM2 supervisor 和 Next 服务，未区分窗口角色。 | 按 5.4 修改并覆盖依赖缺失、构建失败和服务退出。 |
| `MeiTa-OA` | 上线后未实测；隐藏 BAT 内仍包含依赖检查及 Next 启动。 | 按 5.5 修改，分别验证 `start-local-test.bat` 与手动 `start-server.bat`。 |
| `recruitment-assistant` | 上线后未实测；隐藏 BAT 仍经 `npm run start` 启动最终服务。 | 按 5.6 改为直接 Node/tsx 入口的 `service` 角色。 |
| `BeautyHandAILab` | 上线后未实测；隐藏 BAT 仍经 npm/Vite 链启动最终服务。 | 按 5.7 迁移并覆盖资源校验、依赖安装和 Vite 退出。 |
| `SmartMoney` | 上线后未实测；仍是隐藏 BAT 直接启动 Python，且与温度策略同类的控制台中断风险尚未排除。 | 按 5.1 迁移并验证正常退出、Ctrl+C/停止及重复启动。 |

端口 `8023` 在后续检查中出现监听时，其进程链来自独立运行的计划任务 `TemperaturePathWeatherCollector`，不属于上述失败 Run 的管理台托管树。联调时必须核对 `PROJECT_LAUNCHER_RUN_ID`、宿主记录的子 PID 与监听 PID，不能仅凭“端口已开”判断本次启动成功。

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

角色运行器等待目标进程并传播真实退出码。`service` 权限关闭时自动降级为隐藏运行；`interactive` 未授权时拒绝启动。`--` 后第一个参数必须是已解析的 EXE 绝对路径，例如 `C:\Windows\py.exe`、虚拟环境中的 `python.exe` 或 `process.execPath`；不能传 `py`、`python`、`node` 等依赖 `PATH` 搜索的裸命令，也不能把 `py -3.11` 作为一个可执行文件变量。不要把 `npm.cmd`、`.bat` 或任意拼接命令行直接作为目标可执行文件；优先使用 Python/Node 可执行文件和对应模块入口，避免二次 `cmd.exe`。

日志必须继续写入 `PROJECT_LAUNCHER_LOG_DIR`。可见控制台不是日志存储。项目自定义阶段继续按一行一个 UTF-8 JSON 对象追加到 `PROJECT_LAUNCHER_EVENT_FILE`，不得写敏感环境变量。

管理台 Win32 托管宿主会在 stderr 写入两类 UTF-8 诊断行：`[managed-process-host] started pid=<PID> executable=<PATH>` 与 `[managed-process-host] exited pid=<PID> code=<CODE>`。外部启动器不得过滤、改写或把这两行当作业务错误；联调时应用它们建立 Run、启动器 PID、角色运行器 PID 和最终监听 PID 之间的对应关系。诊断行只记录可执行文件路径，不得扩展为完整命令行或环境变量，以免泄露参数和凭据。

## 5. 分项目修改方案

### 5.1 PolymarketBots

`Polymarket-TempPath` 同时受计划任务/watchdog和管理台控制时，还必须执行独立交接 [polymarket-temperature-path-dual-ownership.md](./polymarket-temperature-path-dual-ownership.md)。本节窗口角色迁移不能替代其中的单实例锁、所有权状态和安全停止协议。

建议修改：

- `strategy/temperature/run_trader.bat`：保留 Python 探测、参数校验和失败处理在隐藏启动链；仅在真正执行 `statarb_advisor.py` 时，托管分支通过角色运行器以 `service` 启动并 `exit /b` 传播退出码。手动分支继续直接运行并按原策略 `pause`。
- 角色运行器必须让最终 Python 服务使用独立服务控制台。关闭该服务窗口时，中断事件不能传回隐藏的外层 BAT，否则 `cmd.exe` 会按 CP936 输出“终止批处理操作吗(Y/N)?”并产生 `0xC000013A`。
- `strategy/temperature/mode1_risk_service/launcher.py`：新增纯函数解析交互权限，优先 `PROJECT_LAUNCHER_ALLOW_INTERACTIVE_CONSOLE`，缺失时回退 `PROJECT_LAUNCHER_ALLOW_CHILD_CONSOLE`。只有风险服务确属交互窗口且权限为 `1` 时使用 `CREATE_NEW_CONSOLE`；不得因为 `SHOW_SERVICE_CONSOLES=1` 放行风险交互。
- `strategy/temperature/unit_test/test_mode1_risk_service.py`：把现有旧变量用例扩展为新变量优先级、旧变量回退、两者冲突时新变量优先、未托管手动启动兼容。
- `strategy/temperature_path/scripts/start_server.bat`：探测 Python和目录准备保持隐藏；最终 `analysis_lab.cli --serve --host ... --port ...` 改由 `service` 角色运行器启动并等待。不要复用 `scripts/start.bat` 中 `start ... cmd /k` 的手动逻辑。
- `strategy/smart_money/scripts/start_server.bat`：同样只包装最终 Python 服务；Python 探测和错误提示留在隐藏链。
- 为三个 BAT 增加静态契约测试，断言托管分支存在 `PROJECT_LAUNCHER_ROLE_RUNNER`、`service` 和 `--cwd`，且托管分支没有 `start`、`cmd /k`、`CREATE_NEW_CONSOLE`。

预期：`Polymarket-Temp` 主交易服务显示 1 个服务窗口；风险模式启用且交互权限为 `1` 时再显示 1 个风险窗口。`Polymarket-TempPath`、`SmartMoney` 各显示 1 个服务窗口。

#### 5.1.1 Polymarket-TempPath 退出码 255 的必要修正

`strategy/temperature_path/scripts/start_server.bat` 当前迁移稿仍用一个 `%PYTHON%` 变量同时表示可执行文件和参数。当项目虚拟环境不存在时，该变量取值为 `py -3.11`，角色运行器解析后将 `py` 直接作为 `CreateProcessW.applicationName`，不会按 BAT 的普通命令解析方式自动得到 `C:\Windows\py.exe`，最终宿主返回创建失败标记 `255`。该值不是 Python 服务的业务退出码。

必须把运行时选择拆成两个变量：

```bat
set "PYTHON_EXE="
set "PYTHON_PREFIX_ARGS="

if defined TEMPERATURE_PATH_PYTHON if exist "%TEMPERATURE_PATH_PYTHON%" (
    for %%I in ("%TEMPERATURE_PATH_PYTHON%") do set "PYTHON_EXE=%%~fI"
)
if not defined PYTHON_EXE if exist "%ROOT%\..\.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%ROOT%\..\.venv\Scripts\python.exe"
)
if not defined PYTHON_EXE if exist "%ROOT%\..\..\venv\Scripts\python.exe" (
    set "PYTHON_EXE=%ROOT%\..\..\venv\Scripts\python.exe"
)
if not defined PYTHON_EXE (
    where py >nul 2>nul
    if not errorlevel 1 (
        py -3.11 -c "import sys" >nul 2>nul
        if not errorlevel 1 (
            for /f "delims=" %%I in ('where py 2^>nul') do if not defined PYTHON_EXE (
                set "PYTHON_EXE=%%~fI"
                set "PYTHON_PREFIX_ARGS=-3.11"
            )
        )
    )
)
if not defined PYTHON_EXE (
    for /f "delims=" %%I in ('where python 2^>nul') do if not defined PYTHON_EXE (
        set "PYTHON_EXE=%%~fI"
    )
)
if not defined PYTHON_EXE (
    echo A compatible Python runtime was not found.
    exit /b 1
)
```

Python 校验、网络预检、托管服务和手动服务必须统一复用这两个变量：

```bat
"%PYTHON_EXE%" %PYTHON_PREFIX_ARGS% -c "import sys; import rich; import requests; import websockets; import analysis_lab.cli; print('[temperature_path] Python ' + sys.version.split()[0] + ' - ' + sys.executable)"
"%PYTHON_EXE%" %PYTHON_PREFIX_ARGS% -m infrastructure.network_preflight.cli --dialog

node "%PROJECT_LAUNCHER_ROLE_RUNNER%" service --cwd "%ROOT%" -- "%PYTHON_EXE%" %PYTHON_PREFIX_ARGS% -m analysis_lab.cli --serve --host %HOST% --port %PORT%

"%PYTHON_EXE%" %PYTHON_PREFIX_ARGS% -m analysis_lab.cli --serve --host %HOST% --port %PORT% >> "%LOG_FILE%" 2>&1
```

同步更新 `strategy/temperature_path/tests/configuration/test_python_runtime_startup_contract.py`，至少断言托管分支使用 `-- "%PYTHON_EXE%" %PYTHON_PREFIX_ARGS%`、不再出现 `-- %PYTHON%`，并覆盖“无项目虚拟环境但 `py -3.11` 可用”的路径。运行：

```powershell
py -3.11 -m pytest strategy/temperature_path/tests/configuration/test_python_runtime_startup_contract.py
```

验收时从管理台重新启动：不得再返回 `255`；`127.0.0.1:8023` 必须由本次 Run 的 Python 后代监听；只显示最终 Python 服务窗口，BAT、Python 检查和网络预检继续隐藏；手动启动仍写原项目日志并正常传播退出码。

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
