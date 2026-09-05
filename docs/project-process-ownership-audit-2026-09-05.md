# 项目进程归属与部分运行检查（2026-09-05）

## 结论与检查边界

检查了管理台全部 11 个项目的配置、启动入口、可用的服务子入口、监听进程与运行状态。ViralDNA 存在实际漏认；GoldAlpha 和温度扫尾存在相同机制下可复现的独立子进程漏认风险，已在管理台侧修补。MeiTa-OA 的相对 Node 入口有父进程退出后失去项目路径的风险，需由目标仓库改绝对入口，已提供交接文档。

未启动项目的结论来自只读脚本检查与隔离的进程样本测试，不代表已实际启停所有业务。没有修改任何外部仓库文件，也没有为了检查而启动其他项目。本次仅恢复了用户请求修复的 ViralDNA。

## 全项目结果

| 项目 | 检查时状态/入口 | 本次结论及处理 |
| --- | --- | --- |
| v2rayN | 运行；EXE 绝对路径 | EXE 身份可直接匹配，未发现本次同类问题。 |
| Polymarket-温度扫尾 | 运行；`statarb_advisor.py` 及 `strategy.temperature.mode1_risk_service` | 原规则只匹配主程序；风险子服务失去父链时无法独立识别。新增明确模块匹配组，主程序原规则保留；两个服务之间不会互相冒充不同策略。 |
| Polymarket-温度路径 | 8023/PID 23600 运行 | `analysis_lab.cli` 和 `--port 8023` 均在实际命令中，归属正常，未修改。 |
| ViralDNA | 4174 未监听；8000/PID 33292 运行 | 实际故障：模块名匹配被同一 AND 数组中的绝对目录条件挡住。已修正规则，显示部分运行，清理并完整启动成功。 |
| GoldAlpha | 5173、8110 均未监听；显示旧异常 | 原规则只含项目目录。`goldalpha_api.main:app` 在系统 Python 下独立存活时会漏认。已改为模块特征；路径规则仍保留正常 Web/启动器归属；同时受益于部分运行修复。旧异常未被本次证明与端口问题有关。 |
| 项目管理台 | 3344 正常 | 当前后台正确归属自身；托管宿主边界仍生效，不把子项目端口计为管理台实例。 |
| BeautyTraining | 3010 未监听 | worker 计算绝对 `nextBin` 并启动 Next；常规服务链有项目绝对路径。未发现当前残留。单独运行相对 worker、或进程命令信息丢失的边界仍需保守识别。 |
| MeiTa-OA | 3002 未监听 | BAT 最终执行 `node node_modules\next\dist\bin\next start --port 3002`，参数只有相对路径。父链丢失时有潜在漏认；没有当前故障证据。不能仅凭 Next/3002 放宽匹配，交接目标仓库改绝对入口。 |
| recruitment-assistant | 3218 未监听 | 经 npm/本地 tsx 启动；当前没有漏认进程证据。相对 `src/server/index.ts` 本身不唯一，不加入全局宽泛匹配；依赖本地工具绝对路径/已验证父链。 |
| BeautyHandAILab | 4173 未监听；显示旧异常 | npm/Vite 本地入口；没有本次辅助端口或孤儿 Python 证据。历史退出错误需独立诊断，不计为本次同类故障。 |
| Polymarket-SmartMoney | 8765 未监听；显示旧异常 | `strategy.smart_money.src.server` 唯一模块特征可以匹配系统 Python 的相对模块启动。未发现本次同类问题。 |

## ViralDNA 证据与原因

- 失败 Run：`20260905102007-347aa388`，`checking_ports` 阶段 744 ms 内被 `PROJECT_PORT_CONFLICT` 拦截，启动脚本未执行。
- PID 33292 命令：系统 Python 3.12 + `-m uvicorn viral_dna_api.main:app --app-dir services/api/src --host 127.0.0.1 --port 8000`。
- 创建时间：北京时间 2026-09-04 23:01:38；父 PID 29440 已不存在。现有证据不足以确定最初是谁启动此进程。
- GET `/health` 返回 `service=viral-dna-api`、`status=ok`、`workspace_schema_version=16`。
- `logs/ViralDNA.log` 的 9 月 4 日 23:22 与 9 月 5 日 18:19 停止记录均没有 PID 33292。
- 原配置 `processMatch=["D:\\Projects\\ViralDna", "viral_dna_api.main:app"]` 按 AND 求值；命令没有项目绝对路径且没有存活父链，因此漏认。
- 原状态只根据主端口决定完整运行/停止，辅助端口残留不产生独立状态。即使匹配修正，仍会显示“已手动停止”。

## 管理台修复

1. `config/projects.json`：ViralDNA、GoldAlpha 使用 `-m uvicorn` 加各自唯一模块；温度扫尾使用原 `processMatch` 加风险子服务的额外匹配组。
2. `server/config.js`、`server/config-manager.js`：规范化 `processMatchGroups`，保留每组 AND，组间 OR；无效组整体丢弃、保存时限制组数和条件长度。
3. `server/status-checker.js`：检查主/辅助全部端口的可访问性和归属；返回 `readyPorts`、`missingPorts`；辅助外部进程进入 `externalPids`；部分服务运行优先于旧停止状态。辅助端口属于其他项目/无法验证时显示冲突。
4. `server/project-runner.js`：停止发现检查全部声明端口，仅纳入归属已确认的 PID；仍禁止绕过外部停止权限。没有删除启动前端口冲突防护。
5. `public/app.js`、`public/styles.css`：显示部分运行及停止剩余服务；阻止不完整服务组接管；避免辅助 PID 重复展示；编辑时保留高级匹配组。
6. `server/index.js`：活跃项目检查包括部分运行。

## 验证与实际恢复

- 配置行为测试真实调用归属函数，覆盖系统 Python/相对模块/父链缺失；断言各模块只匹配自己的项目，其他 Uvicorn 服务不会误归属。
- 状态测试覆盖两组主辅助端口、两个方向的部分运行、启动期间等待、外部辅助冲突、旧手动停止状态、正常多服务不误报多实例。
- 停止发现测试覆盖主端口关闭、辅助端口存活、`detectExternal=false` 时依然安全检查端口、排除其他所有者。
- 全量 `node --test --test-reporter=dot` 通过；随后新增的前端渲染测试单独通过。浏览器连接列表为空，未做真实浏览器截图验收。
- 重载后，状态 API 确认 `partial`、`readyPorts=[8000]`、`missingPorts=[4174]`、`externalPids=[33292]`。
- 再次核对命令及创建时间后，通过管理台停止 PID 33292 所属进程链；日志记录关闭 33292 与其后代 12776。
- 预先只读验证基础依赖和配置要求的本地 AI 依赖均可导入，启动无需安装依赖。
- 恢复 Run `20260905104536-3a470451` 于 2026-09-05 18:46:03（北京时间）成功，耗时 26.945 秒，4174 和 8000 均已就绪。
- 最终状态 `running / managed`，前端 PID 4572、API PID 7544，`missingPorts=[]`、`externalPids=[]`；前端 HTTP 200 且含 ViralDNA 标识，API `/health` 为 `ok`。温度扫尾、温度路径和管理台自身复查仍为正常运行。

## 剩余边界

没有将 `processMatch` 的 AND 全局改成 OR，也不把 `node.exe`、`python.exe` 或端口单独视为归属。多个副本使用完全相同业务模块时，需进一步用绝对路径/实例标识区分。本次没有自动启动或停止其他项目来验证这种场景。

MeiTa-OA 的潜在风险详见 [绝对 Node 入口交接](handoffs/meita-oa-absolute-node-entry.md)。此前 PolymarketBots 的双入口所有权交接属于独立工作，不在本次启用或更改其外部控制配置。
