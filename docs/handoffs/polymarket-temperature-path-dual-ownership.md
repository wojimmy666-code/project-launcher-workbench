# Polymarket 温度路径服务“双入口、单实例、显式所有权”实施交接

## 1. 任务、目标路径与边界

- 目标项目：`D:\Projects\PolymarketBots`。
- 目标服务：`strategy\temperature_path`，固定监听 `127.0.0.1:8023`。
- 目标：服务既能由项目管理台启动、接管和停止，也能由计划任务/watchdog或手动脚本独立启动和停止；任何时刻只能存在一个有效实例，所有控制入口必须明确所有权。
- 目标项目 Codex只能修改 `D:\Projects\PolymarketBots`，不得修改 `D:\Projects\project-launcher-workbench` 或其他仓库，不得覆盖项目中已有未提交改动。
- 本管理台交接只定义接口；没有直接修改 PolymarketBots。不得在日志或状态文件中写密码、Token、API Key、Cookie、完整环境变量或业务凭据。

## 2. 现象、影响与复现

当前计划任务 `TemperaturePathWeatherCollector` 在登录后运行：

```text
services.exe
└─ powershell.exe weather_server_watchdog.ps1
   └─ cmd.exe /c start_server.bat
      └─ py.exe -3.11
         └─ python.exe -m analysis_lab.cli --serve --host 127.0.0.1 --port 8023
```

即使用户没有点击管理台启动，PID `40728` 仍会监听 `8023`，管理台正确显示“外部运行”。现有 `weather_server_watchdog.ps1:31-43` 只检查端口；端口关闭后无条件执行 `start_server.bat`，所以管理台或手动脚本直接结束服务后，watchdog会再次拉起。现有 `start_server.bat` 也没有跨入口互斥和所有权状态，管理台、watchdog和手动启动可能同时竞争端口。

必须覆盖的复现：

1. 计划任务运行时从管理台点击停止外部，30-60秒后服务复活。
2. 管理台启动检查与watchdog恰好同时发现端口空闲，两个入口并发创建服务。
3. 外部服务接管后watchdog仍认为自己有重启权。
4. PID状态过期或PID重用时，旧停止命令可能指向错误进程。

## 3. 根因、调用链与证据

- `scripts\weather_server_watchdog.ps1:31-43` 的状态机只有“端口开/关”，没有 `owner`、`desired`、主动停止和崩溃退出之分。
- `scripts\install_weather_startup_task.ps1:24-50` 注册长期计划任务并配置高次数重启，计划任务本身会持续恢复watchdog。
- `scripts\start_server.bat:66-93` 已区分托管和手动分支，但两条路径没有共享原子锁或实例身份记录。
- 当前管理台已实现可选 `externalControl`：启动前、成功、失败、停止、停止外部和接管前均可调用项目控制器；`stopExternal` 配置后管理台不会直接对外部实例执行通用 `taskkill`。
- 管理台仍以端口、PID、创建时间、命令指纹和进程树作为安全依据；项目状态文件只用于协调和展示。

## 4. 管理台接口契约

PolymarketBots实现完成后，由管理台仓库配置以下内容；目标项目不要自行修改管理台配置：

```json
{
  "externalControl": {
    "command": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "cwd": "D:\\Projects\\PolymarketBots\\strategy\\temperature_path",
    "stateFile": "%LOCALAPPDATA%\\PolymarketBots\\temperature-path-control\\desired-state.json",
    "args": [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "D:\\Projects\\PolymarketBots\\strategy\\temperature_path\\scripts\\temperature_path_control.ps1"
    ],
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

控制脚本读取：

- `PROJECT_LAUNCHER_CONTROL_ACTION`：动作名。
- `PROJECT_LAUNCHER_CONTROL_CONTEXT`：JSON，可能包含 `owner`、`instanceId`、`runId`、`launcherPid`、`ports`、`pids`、`sources`、`processCreatedAt`、`commandFingerprint`、`errorCode`。
- `PROJECT_LAUNCHER_PROJECT_ID=Polymarket-TempPath`。
- `PROJECT_LAUNCHER_MANAGED=1`。

动作语义：

| 动作 | 必须完成的行为 |
| --- | --- |
| `prepare-managed-start` | 原子取得控制锁；确认没有外部所有者；写 `desired=running, owner=workbench`；使watchdog待命。 |
| `managed-started` | 记录管理台Run ID、实例ID和已验证启动PID，保持 `owner=workbench`。 |
| `managed-start-failed` | 若状态仍属于同一Run/实例，原子写 `desired=stopped, owner=stopped`，不得影响新一代实例。 |
| `prepare-managed-stop` | 先写 `desired=stopped, owner=stopped`，使watchdog在管理台结束服务前停止拉起。 |
| `stop-external` | 核对上下文PID与实际监听PID，写停止意图，停止外部实例并等待 `8023` 释放；管理台不会再补一次通用taskkill。 |
| `prepare-adopt` | 验证现有外部实例；把watchdog切到待命；写 `owner=workbench` 后返回，管理台随后持久化接管PID。 |

任何动作非零退出或超过15秒，管理台都会中止对应操作。stdout/stderr只写简短非敏感诊断。

## 5. 建议修改文件与逐文件方案

### 5.1 新增 `scripts\temperature_path_control.ps1`

实现上述六个动作，并额外支持外部命令：

```powershell
.\scripts\temperature_path_control.ps1 start-external
.\scripts\temperature_path_control.ps1 stop-external
.\scripts\temperature_path_control.ps1 status
```

状态目录固定为：

```text
%LOCALAPPDATA%\PolymarketBots\temperature-path-control\
├─ desired-state.json
├─ instance.json
└─ control.lock
```

使用同一用户范围的命名互斥量，例如：

```text
Local\PolymarketBots.TemperaturePath.8023.Control
```

互斥锁至少覆盖“读取状态 → 校验端口/PID → 写期望状态 → 创建或停止进程 → 写实例状态”的临界区。状态文件必须通过同目录临时文件加 `Move-Item -Force` 原子替换，不得原地覆盖半个JSON。

`desired-state.json`：

```json
{
  "version": 1,
  "desired": "running",
  "owner": "external",
  "autoRestart": false,
  "generation": "uuid",
  "runId": "external-uuid",
  "updatedAt": "2026-08-31T14:00:00Z"
}
```

`owner` 只允许 `workbench`、`external`、`watchdog`、`stopped`；`desired` 只允许 `running`、`stopped`。`instance.json` 至少记录监听PID、根PID、进程创建时间、Python绝对路径、命令指纹、端口、owner、generation和启动时间。

停止前必须同时验证：PID仍存活、创建时间一致、命令包含 `analysis_lab.cli --serve` 和 `--port 8023`、PID或后代实际监听8023、generation一致。任何一项不一致都拒绝停止并返回非零；不得按 `python.exe` 名称全局结束进程。

### 5.2 新增外部入口

- `scripts\start_server_external.bat`：只调用控制器 `start-external`。端口空闲时写 `owner=external, desired=running, autoRestart=false` 并启动；管理台所有权存在时返回明确冲突码，不抢占。
- `scripts\stop_server_external.bat`：只调用控制器 `stop-external`。默认拒绝停止 `owner=workbench`；若确需跨所有权停止，必须设计独立、显式确认参数，不能作为默认行为。

外部入口也必须复用 `start_server.bat` 的Python 3.11解析规则，最终保存的是EXE绝对路径与单独参数，不得重新引入裸 `py` 的 `CreateProcessW` 问题。

### 5.3 修改 `scripts\weather_server_watchdog.ps1`

端口检查前读取并校验状态：

```text
desired=stopped                         → 待命，不启动
owner=workbench                         → 待命，不启动、不停止
owner=external, autoRestart=false       → 服务退出后保持停止
owner=external, autoRestart=true        → 可重启并保持external所有权
owner=watchdog, desired=running          → 崩溃后按现有延迟重启
状态损坏/版本未知                        → 安全待命并记录告警
```

watchdog启动服务前也必须取得同一互斥量并再次检查端口与generation，避免检查后到创建前被管理台抢占。不要继续直接无条件执行 `start_server.bat`。主动停止必须与异常退出区分；只有仍持有 `watchdog` 或允许自动重启的 `external` generation时才能拉起。

### 5.4 修改 `scripts\start_server.bat`

- 保留当前Python绝对路径拆分、网络预检和管理台 `service` 角色调用。
- 托管分支假设 `prepare-managed-start` 已成功，不再自行抢占外部所有权。
- 手动用户入口改由 `start_server_external.bat` 进入统一控制器；`start_server.bat` 可以继续作为内部实际服务入口，但文档不得再建议用户直接调用它绕过锁。
- 最终服务退出码继续逐层传播；不得在BAT中用 `start`、`cmd /k` 或无跟踪后台进程规避等待。

### 5.5 修改安装和文档

- `scripts\install_weather_startup_task.ps1`：安装后初始化有效状态；建议默认 `owner=watchdog, desired=running, autoRestart=true`。`-Remove` 时先安全停止watchdog所有的实例，再删除任务/快捷方式；不得停止管理台所有权实例。
- `docs\WINDOWS_CONTINUOUS_COLLECTION.md`：说明三个所有权、管理台接管、外部启动/停止、计划任务待命行为和故障恢复。
- `README.md`：用户入口改为新的外部start/stop脚本。

## 6. 正常、失败和边界状态机

| 当前状态 | 请求 | 结果 |
| --- | --- | --- |
| stopped/端口空闲 | 管理台启动 | owner切workbench，watchdog待命，只创建1个服务。 |
| stopped/端口空闲 | 外部启动 | owner切external，只创建1个服务。 |
| stopped/端口空闲 | watchdog启动 | owner切watchdog，只创建1个服务。 |
| external运行 | 管理台普通启动 | 管理台按现有行为报告已外部运行，不创建重复实例。 |
| external运行 | 管理台接管 | prepare-adopt转移所有权，watchdog待命，现有PID被接管。 |
| external/watchdog运行 | 管理台停止外部 | stop-external先写停止意图，再停服务，watchdog不得复活。 |
| workbench运行 | 外部启动 | 明确拒绝，不停止、不抢占管理台实例。 |
| workbench运行 | 管理台停止 | 先prepare-managed-stop，再由管理台结束已跟踪树。 |
| workbench服务崩溃 | watchdog轮询 | 不重启；管理台报告失败。 |
| watchdog服务崩溃 | watchdog轮询 | generation仍有效时按延迟重启。 |
| 两入口同时启动 | 任意 | 命名互斥量决定唯一胜者，失败方重新检查后报告已有实例。 |
| 电脑重启且旧owner=workbench | watchdog启动 | 旧PID无效时转为安全stopped；未经策略明确允许不得擅自接管。 |

管理台多实例误判已在管理台仓库修复：`managed-process-host.ps1` 和 `run-process-role.js` 被视为归属中立边界，ViralDNA等子项目端口不会再反向归属于管理台。PolymarketBots无需复制这部分修复。

## 7. 必须新增的测试、命令和验收标准

建议新增：

- `strategy/temperature_path/tests/configuration/test_service_ownership_contract.py`：静态检查脚本、状态字段、管理台动作名、绝对Python入口和禁止的全局kill模式。
- PowerShell/Pester测试或可从Python调用的隔离测试：原子状态写入、损坏JSON、安全降级、generation竞争、PID重用、命令指纹不一致、端口归属不一致。
- watchdog测试：stopped/workbench不重启，watchdog崩溃可重启，external按autoRestart分流。
- 并发测试：两个控制器同时start，最终只有一个成功，8023只有一个监听根。

至少执行：

```powershell
py -3.11 -m pytest strategy/temperature_path/tests/configuration/test_python_runtime_startup_contract.py
py -3.11 -m pytest strategy/temperature_path/tests/configuration/test_network_preflight.py
py -3.11 -m pytest strategy/temperature_path/tests/configuration/test_service_ownership_contract.py
```

联调验收：

1. 管理台启动/停止各3次，无重复实例，停止后5秒内端口释放。
2. 外部启动/停止各3次，管理台显示“外部独立运行”，停止后60秒内watchdog不复活。
3. watchdog启动时显示“计划任务运行”；管理台接管后显示“已接管”。
4. 同时触发管理台和外部启动20次，任何时刻8023监听PID数不超过1。
5. 模拟服务崩溃，workbench所有权不自动重启，watchdog所有权按策略重启。
6. 所有停止场景均未结束其他Python、管理台、ViralDNA或天气研究进程。

## 8. 风险与防护

- 进程归属风险：不得只按PID或进程名停止；必须结合创建时间、命令指纹、端口和generation。
- 竞争风险：端口检查不是锁；必须使用命名互斥量，并在锁内二次检查。
- watchdog复活风险：所有停止动作先原子写 `desired=stopped`，再结束进程。
- 状态损坏风险：使用临时文件原子替换；未知版本和JSON损坏安全待命，不能默认启动。
- 死锁风险：互斥量设置有限等待和 `finally` 释放；控制动作总时限小于管理台配置的15秒，耗时停止可在发出后轮询端口。
- 权限风险：状态目录限当前用户；计划任务与管理台必须运行在同一用户上下文。不得用管理员权限绕过所有权。
- 数据风险：控制变更不能改变天气数据格式、数据库、采集逻辑或网络预检顺序。
- 兼容风险：直接运行旧 `start_server.bat` 应给出迁移提示或进入受控external路径，不能静默绕过协议。

## 9. 回滚、联调顺序与回传

回滚时先将计划任务置为stopped并停止当前实例，再撤销控制器和watchdog状态机；不要在仍有服务运行时删除状态目录。管理台侧在PolymarketBots完成前不配置 `externalControl`，因此当前通用启动行为不受影响；若外部控制器上线后出现问题，可先移除该项目的 `externalControl` 配置，管理台会回退到原端口/PID管理，但watchdog自动复活问题也会随之恢复。

联调顺序：

1. PolymarketBots完成控制器、状态机和自动化测试。
2. 先停用现有计划任务并清理旧外部实例。
3. 重新安装新版计划任务，验证watchdog模式。
4. 管理台加入 `externalControl` 配置，重启管理台。
5. 按第7节顺序验证外部、管理台、接管、并发和崩溃路径。

完成后回传：修改文件清单、状态机说明、全部测试命令和结果、手工窗口/PID/端口记录、计划任务状态、未解决风险以及 PolymarketBots commit SHA。目标项目Codex不得把管理台仓库的修改混入自己的提交。
