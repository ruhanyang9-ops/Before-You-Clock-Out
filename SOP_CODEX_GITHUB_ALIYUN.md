# Codex → GitHub → 阿里云 ECS 全栈网站部署 SOP

| 文档项 | 内容 |
| --- | --- |
| 文档名称 | Codex 到 GitHub 到阿里云 ECS 全栈网站部署 SOP |
| 适用项目 | Node.js / 全栈网站 / 静态前端 + 后端 API / 数据库应用 |
| 当前示例项目 | 下班前五分钟 |
| GitHub 仓库 | `https://github.com/ruhanyang9-ops/Before-You-Clock-Out.git` |
| 服务器公网 IP | `121.43.231.62` |
| 服务器系统 | Ubuntu 22.04 |
| 部署目录 | `/opt/afterwork-five-minutes` |
| 域名 | `afterwork5.xyz` |
| 运行方式 | Nginx + PM2 + Node.js 24 |
| 数据库 | SQLite 文件库 |
| 维护人 | 项目负责人 / Codex 协作执行 |

## 1. 文档目的

本文档用于规范从 Codex 本地开发环境，到 GitHub 代码仓库，再到阿里云 ECS 生产服务器的完整部署流程。

目标是让以后类似项目可以复用同一套步骤，避免遗漏以下关键环节：

- 代码初始化与 GitHub 推送
- 敏感信息排除
- ECS 环境安装
- Node.js 24、Nginx、PM2 配置
- 数据库与 `.env` 管理
- API Key 接入
- 域名解析与 HTTPS
- 麦克风权限问题处理
- 上线验收、排障与回滚

## 2. 核心原则

1. 不提交 `.env`、API Key、Token、数据库密码。
2. 不提交数据库文件、备份文件、日志文件。
3. 部署脚本不写真实密钥。
4. 服务器上的生产 `.env` 只保存在 ECS。
5. 应用端口只监听 `127.0.0.1`，公网通过 Nginx 访问。
6. 未配置 HTTPS 前，`COOKIE_SECURE=false`。
7. 配置 HTTPS 后，`COOKIE_SECURE=true`。
8. 公网麦克风权限必须使用 HTTPS 域名，不能用 HTTP/IP。

## 3. 角色分工

| 角色 | 负责事项 |
| --- | --- |
| 用户 | 提供服务器、域名、GitHub 仓库、必要 API Key |
| Codex | 检查项目、生成部署文件、执行部署、排障、验证 |
| GitHub | 保存代码仓库 |
| 阿里云 ECS | 运行生产服务 |
| Nginx | 对公网提供 HTTP/HTTPS 访问 |
| PM2 | 守护 Node.js 进程 |

## 4. 当前项目基础信息

| 项目 | 当前值 |
| --- | --- |
| 项目名称 | 下班前五分钟 |
| GitHub 仓库 | `https://github.com/ruhanyang9-ops/Before-You-Clock-Out.git` |
| ECS 公网 IP | `121.43.231.62` |
| ECS 登录用户 | `admin` |
| 部署目录 | `/opt/afterwork-five-minutes` |
| 本地开发地址 | `http://127.0.0.1:4173/` |
| 阿里云 HTTP 地址 | `http://121.43.231.62/` |
| 计划域名 | `afterwork5.xyz` |
| Node.js 版本 | 24+ |
| 生产端口 | `4173` |
| PM2 应用名 | `afterwork-five-minutes` |

## 5. 阶段一：Codex 本地项目检查

### 5.1 检查项目结构

```bash
pwd
rg --files -g '!*node_modules*' -g '!data/**' -g '!backups/**'
git status --short --ignored
```

### 5.2 检查技术栈与启动脚本

```bash
sed -n '1,180p' package.json
rg -n "localhost|127\\.0\\.0\\.1|process\\.env|PORT|DATABASE_URL|fetch\\(" \
  -g '!*node_modules*' \
  -g '!data/**' \
  -g '!backups/**'
```

### 5.3 检查 `.gitignore`

必须忽略：

```text
.env
.env.*
node_modules/
data/
backups/
dist/
build/
*.log
```

允许提交：

```text
.env.example
.env.production.example
```

### 5.4 敏感信息扫描

```bash
rg -n "sk-[A-Za-z0-9]|github_pat_|API[_-]?KEY=.*[A-Za-z0-9]{16,}|SECRET[_-]?KEY=.*[A-Za-z0-9]{16,}" \
  . \
  -g '!.env' \
  -g '!data/**' \
  -g '!backups/**'
```

如发现真实密钥，先移除，再提交。

## 6. 阶段二：GitHub 仓库推送

### 6.1 初始化或确认 Git

```bash
git rev-parse --is-inside-work-tree || git init
git status -sb
```

### 6.2 提交代码

```bash
git add -A
git diff --cached --name-only
git commit -m "first commit"
```

### 6.3 绑定 GitHub 远程仓库

```bash
git remote add origin https://github.com/<用户名>/<仓库名>.git
git branch -M main
```

如果已有其他远程，例如 Gitee，可以保留：

```bash
git remote rename origin gitee
git remote add origin https://github.com/<用户名>/<仓库名>.git
```

### 6.4 推送到 GitHub

```bash
git push -u origin main
```

### 6.5 GitHub Token 授权要求

如果使用 HTTPS 推送，GitHub 密码位置要输入 Personal Access Token，不是账号密码。

Fine-grained token 推荐配置：

| 配置项 | 值 |
| --- | --- |
| Repository access | 选择目标仓库 |
| Contents | Read and write |
| Metadata | Read-only |

如果 Token 出现在聊天或文档中，推送完成后必须吊销并重新生成。

## 7. 阶段三：阿里云 ECS 登录准备

### 7.1 确认 SSH 公钥

```bash
ls ~/.ssh/*.pub
cat ~/.ssh/<你的公钥>.pub
```

### 7.2 如果 Codex 无法 SSH，先用阿里云 Workbench 添加公钥

在阿里云网页终端执行：

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo '<你的 SSH 公钥>' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
whoami
hostname -I
```

### 7.3 从 Codex 本机验证连接

```bash
ssh -i ~/.ssh/<你的私钥> -o IdentitiesOnly=yes admin@121.43.231.62 \
  'whoami && hostname -I && uname -a'
```

## 8. 阶段四：安装 ECS 基础环境

### 8.1 安装基础包

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg git nginx
```

### 8.2 安装 Node.js 24+

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### 8.3 安装 PM2

```bash
sudo npm install -g pm2
pm2 -v
```

## 9. 阶段五：部署代码到 ECS

### 9.1 推荐方式：从 GitHub 克隆

```bash
sudo mkdir -p /opt/afterwork-five-minutes
sudo chown -R "$USER":"$USER" /opt/afterwork-five-minutes
git clone https://github.com/ruhanyang9-ops/Before-You-Clock-Out.git /opt/afterwork-five-minutes
cd /opt/afterwork-five-minutes
```

### 9.2 备用方式：从本机打包上传

当 ECS 拉 GitHub 不稳定时使用：

```bash
git archive --format=tar HEAD | ssh -i ~/.ssh/<私钥> admin@121.43.231.62 \
  'tar -xf - -C /opt/afterwork-five-minutes'
```

## 10. 阶段六：配置生产环境变量

### 10.1 创建 `.env`

```bash
cd /opt/afterwork-five-minutes
cp .env.production.example .env
chmod 600 .env
nano .env
```

### 10.2 HTTP/IP 测试阶段配置

```env
HOST=127.0.0.1
PORT=4173
DATA_DIR=/opt/afterwork-five-minutes/data
COOKIE_SECURE=false
```

### 10.3 API 配置

只写在 ECS 的 `.env`，不要提交到 GitHub：

```env
AI_PROVIDER=deepseek
AI_API_KEY=
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-v4-flash

BAIDU_API_KEY=
BAIDU_SECRET_KEY=
BAIDU_DEV_PID=1537
```

## 11. 阶段七：安装依赖、检查、启动 PM2

```bash
cd /opt/afterwork-five-minutes
mkdir -p data logs backups
npm install
npm run check
```

启动应用：

```bash
pm2 start server.js --name afterwork-five-minutes --update-env --time \
  --output /opt/afterwork-five-minutes/logs/pm2-out.log \
  --error /opt/afterwork-five-minutes/logs/pm2-error.log
```

保存 PM2 状态并设置开机自启：

```bash
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u "$USER" --hp "$HOME"
pm2 status
```

本机健康检查：

```bash
curl http://127.0.0.1:4173/api/health
```

## 12. 阶段八：配置 Nginx 反向代理

### 12.1 启用站点配置

```bash
sudo cp nginx.afterwork-five-minutes.conf /etc/nginx/sites-available/afterwork-five-minutes.conf
sudo ln -sf /etc/nginx/sites-available/afterwork-five-minutes.conf /etc/nginx/sites-enabled/afterwork-five-minutes.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl reload nginx
```

### 12.2 公网测试

```bash
curl http://121.43.231.62/
curl http://121.43.231.62/api/health
```

浏览器访问：

```text
http://121.43.231.62/
```

## 13. 阶段九：验证 API 是否真实接入

### 13.1 健康检查

```bash
curl http://127.0.0.1:4173/api/health
```

期望：

```json
{
  "ai": {
    "enabled": true,
    "mode": "real"
  },
  "speech": {
    "enabled": true,
    "mode": "backend"
  }
}
```

### 13.2 业务验证

1. 打开公网网站。
2. 注册或登录账号。
3. 在工作记录页输入内容。
4. 点击智能整理。
5. 保存记录。
6. 点击自动生成日报。

期望：

- 智能整理返回 `aiMode: real`
- 日报生成返回 `aiMode: real`
- 百度语音状态为 `backend`

## 14. 阶段十：域名解析与 HTTPS

### 14.1 添加 DNS A 记录

在域名解析控制台添加：

```text
@      A    121.43.231.62
www    A    121.43.231.62
```

### 14.2 检查 DNS 是否生效

```bash
dig +short afterwork5.xyz
dig +short www.afterwork5.xyz
```

必须返回：

```text
121.43.231.62
```

### 14.3 配置 Nginx 域名

Nginx 中应包含：

```nginx
server_name afterwork5.xyz www.afterwork5.xyz 121.43.231.62 _;
```

检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 14.4 安装 Certbot

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
certbot --version
```

### 14.5 签发 HTTPS 证书

DNS 生效后执行：

```bash
sudo certbot --nginx -d afterwork5.xyz -d www.afterwork5.xyz
sudo certbot renew --dry-run
```

### 14.6 HTTPS 后更新 Cookie 配置

```bash
cd /opt/afterwork-five-minutes
sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' .env
pm2 restart afterwork-five-minutes --update-env
pm2 save
```

最终访问：

```text
https://afterwork5.xyz/
```

## 15. 麦克风权限说明

浏览器不允许公网 HTTP/IP 页面使用麦克风。

不可用：

```text
http://121.43.231.62/
```

可用：

```text
https://afterwork5.xyz/
```

如果仍提示无法使用麦克风：

1. 检查是否是 HTTPS。
2. 检查浏览器地址栏麦克风权限。
3. 检查系统麦克风权限。
4. 检查浏览器是否禁用了站点录音权限。

## 16. 上线检查表

| 检查项 | 命令或操作 | 结果 |
| --- | --- | --- |
| PM2 在线 | `pm2 status` | 应为 `online` |
| 本机 API | `curl http://127.0.0.1:4173/api/health` | 返回 `ok: true` |
| 公网 API | `curl http://121.43.231.62/api/health` | 返回 `ok: true` |
| Nginx 配置 | `sudo nginx -t` | successful |
| 首页访问 | 浏览器打开公网地址 | 能看到登录页 |
| 登录功能 | 注册/登录 | 可用 |
| AI 整理 | 工作记录智能整理 | `aiMode: real` |
| 日报生成 | 自动生成日报 | `aiMode: real` |
| 语音状态 | `/api/health` | `speech.mode=backend` |
| HTTPS | 浏览器打开域名 | 显示安全锁 |
| 麦克风 | HTTPS 页面录音 | 弹出权限 |

## 17. 常见问题排查

### 17.1 GitHub push 403

原因：

- Token 没有仓库写权限。
- Fine-grained token 没有选择目标仓库。
- `Contents` 权限不是 `Read and write`。

处理：

1. 重新生成 GitHub Token。
2. 选择目标仓库。
3. 设置 `Contents: Read and write`。
4. 重新执行 `git push`。

### 17.2 ECS 克隆 GitHub 卡住

处理：

```bash
git config --global http.version HTTP/1.1
```

仍失败时，从本机上传：

```bash
git archive --format=tar HEAD | ssh -i ~/.ssh/<私钥> admin@121.43.231.62 \
  'tar -xf - -C /opt/afterwork-five-minutes'
```

### 17.3 502 Bad Gateway

```bash
pm2 status
pm2 logs afterwork-five-minutes --lines 100
sudo ss -ltnp | grep 4173
sudo nginx -t
sudo tail -n 80 /var/log/nginx/error.log
```

### 17.4 端口未监听

检查：

```bash
cat /opt/afterwork-five-minutes/.env
pm2 restart afterwork-five-minutes --update-env
sudo ss -ltnp | grep 4173
```

### 17.5 域名未生效

```bash
dig +short afterwork5.xyz
dig +short www.afterwork5.xyz
```

如果没有返回服务器 IP，去域名解析控制台添加或修正 A 记录。

### 17.6 HTTPS 证书失败

常见原因：

- DNS 未生效。
- 80 端口未开放。
- Nginx 配置错误。
- 域名没有指向当前 ECS。

检查：

```bash
sudo nginx -t
curl http://afterwork5.xyz/
sudo certbot certificates
```

## 18. 回滚流程

回滚前先备份数据库：

```bash
cd /opt/afterwork-five-minutes
npm run backup || true
```

回滚代码：

```bash
git log --oneline -5
git checkout <上一个稳定commit>
npm install
npm run check
pm2 restart afterwork-five-minutes --update-env
sudo nginx -t
sudo systemctl reload nginx
```

注意：

- 不要删除 `data/`。
- 不要删除 `.env`。
- 数据库迁移不可逆时，必须从备份恢复。

## 19. 安全规范

1. 不提交 `.env`。
2. 不提交数据库文件。
3. 不提交备份目录。
4. 不在文档里写真实 API Key。
5. 不在文档里写 GitHub Token。
6. 不在文档里写数据库密码。
7. 聊天中暴露过的 Key 或 Token，上线后必须吊销或轮换。
8. 生产数据库和用户数据必须定期备份。

## 20. 相关文件

| 文件 | 用途 |
| --- | --- |
| `ecosystem.config.js` | PM2 配置 |
| `nginx.afterwork-five-minutes.conf` | Nginx 反向代理配置 |
| `deploy.sh` | 部署更新脚本 |
| `.env.production.example` | 生产环境变量示例 |
| `README_ALIYUN_DEPLOY.md` | 当前项目阿里云部署说明 |
| `README_DEPLOY_ALIYUN.md` | 通用阿里云部署说明 |
| `SOP_CODEX_GITHUB_ALIYUN.md` | 本 SOP |
| `.codex/skills/aliyun-fullstack-deploy/` | 可复用 Codex 阿里云部署 Skill |

## 21. 参考资料

- GitHub Personal Access Tokens: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- GitHub fine-grained token permissions: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- NodeSource Node.js 24: https://docs.nodesource.com/docs/nsolid/quickstart/local/
- Certbot Nginx on Ubuntu: https://certbot.eff.org/instructions?ws=nginx&os=ubuntufocal
