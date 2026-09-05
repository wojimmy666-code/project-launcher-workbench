# MeiTa-OA：为独立 Node 服务保留绝对项目入口

## 1. 目标与边界

目标仓库 `D:\Projects\MT_Attendance`，管理台项目 ID `MeiTa-OA`，端口 3002。目标仓库 Codex 负责启动脚本和该项目测试；禁止修改 `D:\Projects\project-launcher-workbench`、其他项目、用户未提交改动、数据库内容和依赖版本。此文档是潜在风险交接，不表示现在有遗留服务，实施前先检查目标仓库最新状态。

## 2. 现象与复现条件

2026-09-05 只读检查时 3002 没有监听；因此没有现场故障。已确认 `scripts/start-local-test.bat:36` 使用：

```text
node node_modules\next\dist\bin\next start --port 3002
```

管理台通过项目路径、显式模块特征或可信父进程链识别服务。系统 Node 可执行文件和此相对命令均不含项目目录。如果 BAT/父进程退出而 Next 子进程继续运行，归属可能无法确认，停止发现可能漏掉服务，随后启动被端口预检拦截。

## 3. 根因与证据

- `scripts/start-local-test.bat:6` 通过 `cd /d` 设置工作目录，但工作目录不等于 Windows 可枚举的命令行内容。
- 同文件最后一条 Node 命令使用相对入口；不能据此区分其他 Next 项目。
- 管理台 `server/status-checker.js` 的 `processMatchesProject` 与 `processLineageMatchesProject` 需要进程自身路径/特征或尚存的可信父链。
- 管理台不会为了这个案例单独信任 `next` 或 `--port 3002`，也不会把编辑器/Codex 父链当作业务归属。

## 4. 接口与兼容契约

- 保持监听端口 3002、工作目录 `D:\Projects\MT_Attendance`、启动参数、现有构建/数据库步骤及其顺序不变。
- 保持 `PROJECT_LAUNCHER_MANAGED`、`PROJECT_LAUNCHER_INSTANCE_ID`、`PROJECT_LAUNCHER_RUN_ID`（如被使用）、`PROJECT_LAUNCHER_LOG_DIR`、`PROJECT_LAUNCHER_EVENT_FILE` 等已注入变量的继承。不要打印完整环境变量。
- 管理台当前配置 `processMatch=["D:\\Projects\\MT_Attendance"]`；绝对 Node 脚本参数即可匹配，无需管理台改成端口或通用 Node 匹配。
- 托管日志目录仍由 `PROJECT_LAUNCHER_LOG_DIR` 指定，保持真实退出码逐层返回。不新增中间可见窗口，不改变现有服务窗口策略。

## 5. 文件与修改方法

1. `scripts/start-local-test.bat`：在 `setlocal` 内使用 `for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"` 解析绝对仓库根；以该根设置工作目录；将最终命令改为 `node "%PROJECT_ROOT%\node_modules\next\dist\bin\next" start --port 3002`。正确引用带空格路径。
2. 如果脚本通过中间 supervisor 启动业务 Node，也必须让最终服务的参数保留绝对 Next 入口，而非仅在最外层出现绝对路径。
3. 新增隔离脚本测试，例如 `scripts/startup-identity.test.mjs`：读 BAT 验证最终命令使用绝对入口变量；用临时目录中的无业务 Node fixture 验证参数中存在绝对路径和退出码传播。不要运行真实 `prisma:push` 或全量 BAT 作为自动化测试。
4. 在项目启动说明中解释独立服务需要保留可识别的入口路径。

## 6. 边界行为

- 手动启动和托管启动都必须带绝对业务入口。
- 缺失 Node/Next、构建失败仍返回非零；不通过重装依赖掩盖失败。
- 父启动器正常退出、异常关闭或服务独立存活时，最终服务命令仍应可识别。
- 不增加自动抢占 3002 或按进程名称杀进程。另一程序占用端口时应报错。
- 保留既有单实例行为，不在此修改中增加后台重启循环。
- 停止动作只能针对已核验归属的进程，不停止其他 Next 项目或编辑器。

## 7. 测试与验收

目标仓库中执行：

```powershell
node --test scripts/startup-identity.test.mjs
```

预期覆盖普通路径、带空格路径、缺失入口、fixture 非零退出；全部通过。只有在目标项目维护者确认开发数据库/构建环境后才进行真实手动启动，避免 `prisma:push` 改写非测试数据库。

只读观察真实服务：

```powershell
Get-NetTCPConnection -LocalPort 3002 -State Listen
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine
```

验收标准：实际监听服务命令含目标仓库绝对 Next 入口；使用隔离进程 fixture 模拟父退出后，管理台身份函数仍能匹配正确项目，且对另一个 Next 项目返回不匹配。不要为了测试父退出而关闭用户真实业务。

## 8. 风险与保护

主要风险是 Windows 路径引用、BAT 退出码丢失和误停止同名 Node。必须保留引号、退出码、工作目录；只改入口参数，不变更构建、迁移、业务数据、凭据、端口或依赖。若 Next 自身重写进程标题导致 WMI 命令不含入口，回传实际证据，不猜测可识别性；再协调持久化实例身份方案。

## 9. 回滚与联调

用单独 commit 提交启动入口与测试修改，出现回归时 revert 该 commit；不回滚其他业务提交，不删除数据库。先完成隔离测试，再进行受控手动/托管验证，最后回管理台做只读归属检查。回传修改文件、全部测试命令/结果、实际进程命令与 PID/创建时间、未解决边界、commit SHA。
