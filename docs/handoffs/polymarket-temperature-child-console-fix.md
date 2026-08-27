# Polymarket Temperature 风控子控制台修复任务

## 任务边界

本文档交给 Polymarket Codex 执行。只修改 `D:\Projects\PolymarketBots` 中 Temperature 项目的风控启动与测试；不要修改项目管理台仓库。

管理台侧已经完成新的启动权限契约：

- `PROJECT_LAUNCHER_MANAGED=1`：进程由项目管理台托管。
- `PROJECT_LAUNCHER_ALLOW_CHILD_CONSOLE=1`：当前项目获准创建一个受控的独立子控制台。
- `PROJECT_LAUNCHER_LOG_DIR`：本次 Launch Run 的日志目录。
- `PROJECT_LAUNCHER_INSTANCE_ID`：当前多开实例标识，可用于生成互不冲突的日志文件名。

`Polymarket-Temp` 配置已设置 `allowChildConsole: true`。其他项目默认得到
`PROJECT_LAUNCHER_ALLOW_CHILD_CONSOLE=0`。

## 已确认的回归原因

回归由提交 `db11ab7` 引入：

1. 管理台设置 `PROJECT_LAUNCHER_MANAGED=1`。
2. `strategy/temperature/mode1_risk_service/launcher.py` 在托管模式下取消 `CREATE_NEW_CONSOLE`。
3. 该分支只设置 `stdin=DEVNULL`，stdout/stderr仍继承主程序输出。
4. `.env.local` 中 `MODE1_RISK_START_CONSOLE=true`，所以风控进程仍启动交互线程。
5. `console.py` 的 `input("mode1-risk> ")` 从 DEVNULL 读到 EOF，捕获异常后继续循环，反复输出提示符。

结果是风控日志和 `mode1-risk>` 提示符污染主策略日志，同时交互控制台实际上不可用。

## 必须修改的代码

### 1. `mode1_risk_service/launcher.py`

计算是否创建独立控制台：

```text
requested = MODE1_RISK_START_CONSOLE 为 true
managed = PROJECT_LAUNCHER_MANAGED 为 1
allowed = PROJECT_LAUNCHER_ALLOW_CHILD_CONSOLE 为 1

use_child_console = Windows 且 requested 且（非 managed 或 allowed）
```

当 `use_child_console=true`：

- 使用 `subprocess.CREATE_NEW_CONSOLE`。
- 不设置 `DETACHED_PROCESS`，保证管理台仍能按进程树停止风控服务。
- 不把 stdin 设置为 DEVNULL。
- 不把 stdout/stderr继承到主策略日志；独立控制台应拥有自己的标准输入输出。

当 `use_child_console=false`：

- 传给风控子进程的环境变量必须覆盖为 `MODE1_RISK_START_CONSOLE=false`，不要启动无输入来源的交互线程。
- stdin 使用 DEVNULL。
- stdout/stderr写入独立日志文件，不要继承主策略输出，也不要直接丢弃。

托管模式下日志文件建议为：

```text
%PROJECT_LAUNCHER_LOG_DIR%\mode1-risk-<PROJECT_LAUNCHER_INSTANCE_ID>.log
```

实例标识必须先转换为安全文件名。未提供 Launch Run 目录时，回退到项目现有日志目录。

### 2. `mode1_risk_service/console.py`

交互循环遇到 EOF 必须立即退出：

```python
try:
    command = input("mode1-risk> ")
except EOFError:
    return
```

不要在 EOFError 后休眠并重新读取。其他真正的暂时性异常可以保留原有恢复策略。

### 3. 进度上报

保留现有 `PROJECT_LAUNCHER_EVENT_FILE` 阶段上报。允许独立控制台与启动进度上报不冲突。

## 必须修改或增加的测试

更新 `strategy/temperature/unit_test/test_mode1_risk_service.py`，删除“托管模式一定不创建新窗口且 stdout/stderr不重定向”的错误断言，并覆盖：

1. Windows＋托管＋`ALLOW_CHILD_CONSOLE=1`＋`MODE1_RISK_START_CONSOLE=true`：使用 `CREATE_NEW_CONSOLE`，交互输入可用。
2. Windows＋托管＋`ALLOW_CHILD_CONSOLE=0`：不创建新控制台，子进程收到 `MODE1_RISK_START_CONSOLE=false`，输出进入独立日志。
3. 非托管手动启动＋控制台开启：保持原有独立交互窗口。
4. 控制台配置关闭：不创建窗口，不污染父进程 stdout/stderr。
5. `input()` 抛出 EOFError：交互线程立即结束，提示符不会重复输出。
6. 管理台停止主策略时，风控子进程仍属于可终止的后代进程树。
7. 多开实例使用不同的风险日志文件名。

建议至少运行：

```powershell
python -m pytest strategy/temperature/unit_test/test_mode1_risk_service.py -q
```

## 联调验收标准

- 管理台启动 Temperature 后，风控日志不再混入主策略日志。
- 当两个开关都允许时，只出现一个独立的风控交互窗口。
- `mode1-risk>` 不会在无输入环境中无限刷屏。
- 风控启动失败时，Launch Run 目录中保留 `mode1-risk-*.log`。
- 管理台生成的 `diagnostic.md` 包含该独立日志的路径和脱敏尾部内容。
- 停止某个 Temperature 实例不会关闭项目管理台，也不会误杀其他 Temperature 实例。

## 禁止事项

- 不要把管理台的 `hideConsole` 全局改回 false。
- 不要恢复“所有托管子进程一律继承 stdout/stderr”的行为。
- 不要用 DEVNULL 丢弃风控失败日志。
- 不要使用 `DETACHED_PROCESS` 或脱离父进程树的启动方式。
- 不要修改交易策略、下单逻辑、撤单逻辑或实时数据代码。

完成后请回传：修改文件列表、测试结果、commit SHA，以及一次由管理台启动/停止的进程树与日志隔离验证结果。
