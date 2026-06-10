# 下班前五分钟

面向职场用户的工作记录、AI 整理、周报/月报生成、待办管理和历史归档工具。

当前版本是本地优先 MVP：静态前端 + Node 内置 HTTP 服务 + Node 24 `node:sqlite` + SQLite 文件数据库。项目不依赖 npm 第三方包，适合先做本地验证和小范围内测。

## 当前能力

- 快速记录：支持文字输入，并已接入语音输入入口。
- 整理结果预览：仅保留今日完成、进行中事项、待办事项，减少无用字段干扰。
- 智能整理：支持 DeepSeek 真实 AI，失败时回退本地 mock 规则。
- 语音转文字：单次最长 3 分钟；优先浏览器内置语音识别，网络不可用时可走后端 STT；当前支持百度智能云语音识别，转写后会自动做简单润色预处理。
- 报告生成：生成类型收敛为周报、月报；今日日报放在今日结构化记录中一键自动生成。
- 待办管理：支持新增、编辑、删除、标记完成、筛选。
- 项目归档：首页可快速创建项目；项目支持开始日期、收尾日期、关闭归档，并自动生成项目复盘。
- 复盘与洞察：支持日期、关键词、项目筛选，查看历史结构化记录和总结，并支持删除记录或总结。
- 个人定制：支持岗位、目标、汇报对象、输出风格、模板、关键词、协作对象配置。
- 内测保护：可通过 `APP_ACCESS_PASSWORD` 开启访问口令。
- 数据备份：提供 SQLite 备份脚本。

## 本地启动

要求 Node.js 24 或更高版本。

```bash
node server.js
```

带真实 AI、语音和访问口令启动时，通过环境变量传入密钥，不要把密钥写入代码或文档。

```bash
DEEPSEEK_API_KEY="你的key" \
AI_MODEL="deepseek-v4-flash" \
BAIDU_API_KEY="你的百度API Key" \
BAIDU_SECRET_KEY="你的百度Secret Key" \
APP_ACCESS_PASSWORD="内测口令" \
node server.js
```

打开：

```text
http://127.0.0.1:4173/
```

## 常用命令

```bash
npm start
npm run check
npm run backup
```

当前环境如果没有 `npm`，可以直接运行：

```bash
node --check server.js
node --check aiService.js
node --check speechService.js
node --check app.js
node scripts/backup-sqlite.js
```

## 文件说明

| 路径 | 作用 |
| --- | --- |
| `index.html` | 单页应用 HTML 入口。 |
| `styles.css` | 参考图风格的桌面端 UI 样式。 |
| `app.js` | 前端业务逻辑、页面路由、状态渲染、语音录制与 API 调用。 |
| `server.js` | Node HTTP 服务、静态文件服务、API 路由、SQLite 表结构和 CRUD。 |
| `aiService.js` | DeepSeek AI 调用、本地 mock 整理与总结生成兜底。 |
| `speechService.js` | 百度 / OpenAI-compatible 后端语音转文字服务封装。 |
| `package.json` | 项目信息与启动、检查、备份脚本。 |
| `.env.example` | 环境变量示例，不包含真实密钥。 |
| `.gitignore` | 忽略数据库、备份、`.env` 等本地敏感/运行文件。 |
| `DEPLOY.md` | 云服务器、systemd、Caddy、备份部署说明。 |
| `PROJECT_STATUS.md` | 当前进度、文件整理结果和未完成工作清单。 |
| `scripts/backup-sqlite.js` | SQLite 备份脚本。 |
| `data/app.sqlite` | 本地 SQLite 数据库。 |
| `data/app.sqlite-wal` / `data/app.sqlite-shm` | SQLite WAL 运行时文件。 |
| `backups/*.sqlite` | 手动或定时备份生成的数据库快照。 |

## 数据安全提醒

- API Key 只通过环境变量配置。
- 不要把 `.env`、`data/*.sqlite`、`backups/` 提交到公开仓库。
- 真实 AI 模式下，工作记录内容会发送给配置的 AI 服务。
- 语音后端模式下，录音会先传到本地后端，再发送给配置的 STT 服务。
