# 本地项目执行管理台方案

## 1. 目标

建立一个本地运行的项目启动和管理工作台，用于集中管理散落在不同硬盘位置的项目、页面、`.exe`、`.bat`、命令行工具、文档和文件夹。

选定界面风格：**02 表格运维型**。

核心目标：

- 一个页面集中查看所有项目入口。
- 支持搜索、分类、状态筛选。
- 支持启动 `.exe`、`.bat`、命令、网页、文件夹和文件。
- 支持端口/进程状态检测。
- 支持查看日志、最近启动时间、收藏项目。
- 所有项目通过配置文件维护，后续新增项目不需要改代码。

## 2. 推荐形态

采用“本地 Web 工作台 + 本地后端 + JSON 配置”的方式。

```text
浏览器页面
  ↓
本地后端服务
  ↓
projects.json 配置文件
  ↓
启动 exe / bat / npm / python / 打开网页 / 打开目录
```

使用方式：

```text
双击 start-workbench.bat
  ↓
启动本地后端服务
  ↓
自动打开 http://localhost:3344
```

第一版不建议直接做 Electron 桌面应用。先把 Web 版跑顺，后续如果需要桌面图标、托盘、开机自启，再封装成 Electron 或 Tauri。

## 3. 页面设计

采用高密度、清晰、偏运维后台的表格布局。

```text
左侧分类栏
├─ 全部项目
├─ 正在运行
├─ 前端页面
├─ 后端服务
├─ 批处理脚本
├─ 命令行工具
├─ 文档/文件夹
└─ 收藏

顶部工具栏
├─ 搜索框
├─ 状态筛选
├─ 类型筛选
├─ 批量检查
├─ 批量启动
└─ 新增项目

项目表格
├─ 项目名称
├─ 状态
├─ 类型
├─ 路径/命令
├─ 端口/网址
├─ 最近启动
└─ 操作按钮
```

每个项目行建议支持：

- 启动
- 停止
- 重启
- 打开网页
- 打开目录
- 查看日志
- 编辑配置

## 4. 项目类型

第一版建议支持这些类型：

| 类型 | 用途 | 示例 |
|---|---|---|
| `exe` | 启动软件 | `D:\Tools\App\app.exe` |
| `bat` | 执行批处理 | `D:\Scripts\start.bat` |
| `cmd` | 执行命令 | `npm run dev` |
| `url` | 打开网页 | `http://localhost:3000` |
| `folder` | 打开目录 | `D:\Projects\xxx` |
| `file` | 打开文件 | `E:\Docs\说明.docx` |

## 5. 配置文件设计

所有项目存放在 `projects.json` 中。页面只读取配置，不把项目写死在代码里。

示例：

```json
{
  "projects": [
    {
      "id": "exam-admin",
      "name": "门店考试后台",
      "type": "cmd",
      "category": "前端页面",
      "cwd": "D:\\Projects\\exam-admin",
      "command": "npm run dev",
      "url": "http://localhost:3000",
      "port": 3000,
      "tags": ["常用", "Next.js"],
      "favorite": true,
      "logFile": "logs\\exam-admin.log"
    },
    {
      "id": "import-tool",
      "name": "数据导入工具",
      "type": "bat",
      "category": "批处理脚本",
      "path": "D:\\Tools\\imports\\run-import.bat",
      "cwd": "D:\\Tools\\imports",
      "tags": ["导入", "批处理"],
      "favorite": false,
      "logFile": "logs\\import-tool.log"
    }
  ]
}
```

推荐字段说明：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，建议英文短名 |
| `name` | 页面显示名称 |
| `type` | `exe` / `bat` / `cmd` / `url` / `folder` / `file` |
| `category` | 左侧分类 |
| `cwd` | 启动命令所在目录 |
| `command` | 命令型项目的启动命令 |
| `path` | `.exe`、`.bat`、文件或目录路径 |
| `url` | 可打开的网址 |
| `port` | 用于状态检测的端口 |
| `tags` | 搜索和筛选用标签 |
| `favorite` | 是否收藏 |
| `logFile` | 日志文件路径 |

## 6. 状态判断

状态应尽量基于真实检测，而不是只看用户是否点过“启动”。

```text
运行中：端口可访问，或进程存在
未启动：端口不通，进程不存在
异常：启动过但端口未通，或命令异常退出
未知：没有配置端口或进程检测方式
```

建议颜色：

| 状态 | 颜色 | 说明 |
|---|---|---|
| 运行中 | 绿色 | 服务或页面可访问 |
| 未启动 | 黄色 | 配置正常，但当前未运行 |
| 异常 | 红色 | 启动失败或端口异常 |
| 未知 | 灰色 | 无检测依据 |

## 7. 后端接口设计

第一版可提供这些 API：

| 接口 | 方法 | 用途 |
|---|---|---|
| `/api/projects` | GET | 获取项目列表 |
| `/api/projects/:id/status` | GET | 获取单个项目状态 |
| `/api/status/all` | GET | 批量获取状态 |
| `/api/projects/:id/start` | POST | 启动项目 |
| `/api/projects/:id/stop` | POST | 停止项目 |
| `/api/projects/:id/restart` | POST | 重启项目 |
| `/api/projects/:id/open-url` | POST | 打开项目网址 |
| `/api/projects/:id/open-folder` | POST | 打开项目目录 |
| `/api/projects/:id/logs` | GET | 查看日志 |

## 8. 安全策略

因为这个工具会执行本机命令，必须采用白名单策略。

关键规则：

- 只能启动 `projects.json` 中登记过的项目。
- 页面不能提交任意 shell 命令。
- 启动前检查路径是否存在。
- `.bat`、`.exe`、`cmd` 类型分开处理。
- 高风险命令需要在配置里显式标记。
- 默认仅监听 `127.0.0.1`，不开放局域网访问。
- 日志中不要记录密码、token、密钥。

建议配置：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3344
  },
  "security": {
    "allowOnlyConfiguredProjects": true,
    "confirmDangerousActions": true,
    "allowNetworkAccess": false
  }
}
```

## 9. 技术选型

推荐第一版：

| 模块 | 建议 |
|---|---|
| 前端 | HTML/CSS/JS 或 React |
| 后端 | Node.js + Express |
| 配置 | `projects.json` |
| 日志 | `logs/*.log` |
| 启动脚本 | `start-workbench.bat` |
| 本地地址 | `http://localhost:3344` |

如果后续升级桌面版：

| 方向 | 适合情况 |
|---|---|
| Electron | 需要成熟桌面能力、托盘、窗口管理 |
| Tauri | 希望更轻量、安装包更小 |

## 10. 第一版功能范围

建议第一版先做这些：

- 项目列表
- 搜索
- 分类筛选
- 状态筛选
- 启动项目
- 打开目录
- 打开网页
- 查看日志
- 端口状态检测
- `projects.json` 配置
- `start-workbench.bat` 一键启动工作台

暂缓功能：

- 可视化新增项目表单
- 拖拽排序
- 系统托盘
- 开机自启
- 权限管理
- 团队共享

## 11. 建议目录结构

```text
D:\Projects\project-launcher-workbench
├─ docs
│  ├─ workbench-plan.md
│  └─ workbench-plan.html
├─ public
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ server
│  ├─ index.js
│  ├─ project-runner.js
│  └─ status-checker.js
├─ config
│  └─ projects.json
├─ logs
├─ package.json
└─ start-workbench.bat
```

## 12. 开发阶段

### 阶段 1：静态页面定稿

基于 02 表格运维型模板，确定最终布局：

- 左侧分类
- 顶部工具栏
- 项目表格
- 状态标签
- 操作按钮
- 日志弹窗
- 配置详情弹窗

### 阶段 2：配置驱动

接入 `projects.json`：

- 从配置读取项目。
- 根据类型渲染不同操作。
- 搜索和筛选基于配置字段。

### 阶段 3：真实启动能力

后端实现：

- 启动 `.exe`
- 执行 `.bat`
- 执行固定命令
- 打开网页
- 打开目录
- 写入日志

### 阶段 4：状态检测和日志

增加：

- 端口检测
- 进程检测
- 最近启动时间
- 异常状态
- 日志查看

### 阶段 5：增强功能

可选增加：

- 批量启动组合
- 项目收藏
- 配置编辑页面
- 备份配置
- 桌面版封装

## 13. 最终建议

推荐路线：

```text
先做本地 Web 工作台
  ↓
把 02 表格运维型做成真实页面
  ↓
接 projects.json
  ↓
接本机启动能力
  ↓
再考虑 Electron/Tauri 桌面封装
```

这样风险低、迭代快，第一版很快就能真正替代散落的快捷方式和批处理文件。
