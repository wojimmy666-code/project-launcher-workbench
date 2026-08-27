# 启动任务、进度与失败日志

项目管理台会为每次 `start` / `restart` 创建独立的启动任务（Launch Run）。HTTP 请求会立即返回 `202` 和 `runId`，启动确认在后台继续执行。

## 通用阶段

所有可运行项目自动获得以下阶段，不需要修改项目代码：

1. 校验配置
2. 检查端口和现有实例
3. 创建进程
4. 等待进程
5. 等待目标及辅助端口
6. 核验端口归属
7. 启动成功或失败

阶段没有伪造的百分比。管理台显示当前阶段与真实耗时；只有项目本身知道确定的总工作量时，才适合额外上报数值进度。

## 项目自定义阶段

管理台启动进程时会注入以下环境变量：

- `PROJECT_LAUNCHER_RUN_ID`：本次启动任务 ID。
- `PROJECT_LAUNCHER_EVENT_FILE`：可追加写入的 NDJSON 事件文件。
- `PROJECT_LAUNCHER_LOG_DIR`：本次启动的日志目录。
- `PROJECT_LAUNCHER_MANAGED=1`：表示进程由管理台托管。
- `PROJECT_LAUNCHER_ALLOW_CHILD_CONSOLE=1|0`：是否明确允许项目创建独立子控制台。

项目可选地向 `PROJECT_LAUNCHER_EVENT_FILE` 追加一行 JSON：

```json
{"type":"stage","stage":"database_migration","label":"迁移数据库","message":"正在应用 3 个迁移"}
```

字段约束：

- `type` 必须是 `stage`。
- `stage` 是项目内稳定的英文标识。
- `label` 是界面显示的简短阶段名。
- `message` 是可选的当前工作说明。
- 每个事件独占一行；使用 UTF-8 追加写入，不要覆盖文件。
- 上报失败不能阻止项目启动。
- 不要在事件中写密码、Token、API Key、Cookie 或完整环境变量。

项目上报的细分阶段会插入通用阶段显示；后续通用检查仍由管理台负责。

## Windows 托管启动约束

`hideConsole` 只作用于管理台直接创建的根进程，不能递归隐藏项目脚本主动创建的新控制台。项目在
`PROJECT_LAUNCHER_MANAGED=1` 时应遵守以下约束：

- 默认不使用 `start`、`cmd /k`、PowerShell `Start-Job` 或 `CREATE_NEW_CONSOLE`。
- 只有 `PROJECT_LAUNCHER_ALLOW_CHILD_CONSOLE=1` 且项目确实需要交互终端时，才允许创建一个受控的独立子控制台。
- 多服务项目应由一个前台 supervisor 直接创建子进程，并设置 `shell: false`、`windowsHide: true`。
- 子进程应继承 stdout/stderr，使启动日志进入本次 Launch Run；不要为服务另开仅用于日志的终端。
- 获准使用独立子控制台的项目仍应把关键日志写入 `PROJECT_LAUNCHER_LOG_DIR`；失败诊断会收集其中额外的 `.log` 文件。
- 健康检查和端口归属由管理台负责，项目脚本不应通过循环反复创建 PowerShell 进程轮询。
- `.bat` 文件统一使用 CRLF。手动启动分支可以保留可见终端，但必须与托管分支明确隔离。

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

默认每个项目保留最近 20 次或 14 天内的记录；单次启动日志总预算约 20 MB，超出时保留尾部。

## Codex 失败分析

失败后点击“用 Codex 分析”，管理台会：

1. 在项目目录打开新的交互式 Codex CLI。
2. 把 `diagnostic.md` 的路径作为初始任务上下文。
3. 要求 Codex先读取证据并给出根因和方案，默认不直接修改代码。

诊断材料包含失败阶段、退出码、端口监听、相关进程、Git 分支/提交、stderr 和合并日志尾部。它不会收集完整环境变量，并会对常见凭据格式进行脱敏。
