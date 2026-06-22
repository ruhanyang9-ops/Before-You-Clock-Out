# 阿里云 ECS 部署说明

本项目适合用 Nginx + PM2 部署：Nginx 对公网提供 HTTP/HTTPS，PM2 在本机运行 Node 服务，SQLite 数据保存在 ECS 本地磁盘。

当前生产地址：`https://afterwork5.xyz/`

## 1. ECS 建议

- 系统：Ubuntu 22.04 LTS 或 Ubuntu 24.04 LTS
- 规格：小范围使用建议 2 vCPU / 2GB 起步；多人长期使用建议 2 vCPU / 4GB
- 磁盘：系统盘 40GB 起步；如有长期数据，建议单独数据盘并定期快照
- 带宽：1-5Mbps 可满足小范围办公工具使用
- 安全组：至少开放 22、80、443

## 2. Ubuntu 环境准备

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg git nginx
```

安装 Node.js 24+：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

安装 PM2：

```bash
sudo npm install -g pm2
pm2 -v
```

## 3. 克隆项目

建议部署目录固定为 `/opt/afterwork-five-minutes`：

```bash
sudo mkdir -p /opt/afterwork-five-minutes
sudo chown -R "$USER":"$USER" /opt/afterwork-five-minutes
git clone https://gitee.com/Yang_ruhan/five-minutes-to-freedom.git /opt/afterwork-five-minutes
cd /opt/afterwork-five-minutes
```

安装依赖并检查代码：

```bash
npm install
npm run check
```

## 4. 创建生产 .env

```bash
cp .env.production.example .env
nano .env
chmod 600 .env
```

至少确认这些值：

```env
HOST=127.0.0.1
PORT=4173
DATA_DIR=/opt/afterwork-five-minutes/data
COOKIE_SECURE=true
AI_API_KEY=你的 DeepSeek Key
BAIDU_API_KEY=你的百度智能云 API Key
BAIDU_SECRET_KEY=你的百度智能云 Secret Key
```

不要把 `.env` 提交到 Git。生产密钥只保存在服务器。

## 5. 启动 PM2

```bash
mkdir -p data logs backups
pm2 startOrReload ecosystem.config.js --env production
pm2 save
pm2 startup
```

`pm2 startup` 会输出一行 `sudo env PATH=... pm2 startup ...` 命令，复制执行它即可开启开机自启。

常用命令：

```bash
pm2 status
pm2 logs afterwork-five-minutes
pm2 restart afterwork-five-minutes
```

本机健康检查：

```bash
curl http://127.0.0.1:4173/api/health
```

## 6. 配置 Nginx

复制配置文件：

```bash
sudo cp nginx.afterwork-five-minutes.conf /etc/nginx/sites-available/afterwork-five-minutes.conf
sudo ln -sf /etc/nginx/sites-available/afterwork-five-minutes.conf /etc/nginx/sites-enabled/afterwork-five-minutes.conf
```

编辑域名：

```bash
sudo nano /etc/nginx/sites-available/afterwork-five-minutes.conf
```

把：

```nginx
server_name example.com www.example.com;
```

改成你的真实域名。

检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 7. 阿里云安全组

在阿里云控制台进入 ECS 实例安全组，开放：

- TCP 80：HTTP
- TCP 443：HTTPS
- TCP 22：SSH，仅建议限制为你的办公 IP

Node 的 `4173` 端口不需要对公网开放，只由 Nginx 在本机访问。

## 8. 域名解析

在域名 DNS 控制台添加 A 记录：

```text
主机记录：@
记录类型：A
记录值：ECS 公网 IP
```

如果使用 `www`：

```text
主机记录：www
记录类型：A
记录值：ECS 公网 IP
```

等待解析生效后访问：

```text
http://你的域名
```

## 9. 配置 HTTPS

推荐使用 Certbot 自动签发 Let's Encrypt 证书：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com -d www.example.com
```

把命令里的 `example.com` 换成你的域名。签发完成后，Certbot 会自动修改 Nginx 配置并添加 443 HTTPS。

确认自动续期：

```bash
sudo certbot renew --dry-run
```

如果已经启用 HTTPS，`.env` 中保持：

```env
COOKIE_SECURE=true
```

## 10. 部署更新

首次部署完成后，后续更新可以执行：

```bash
cd /opt/afterwork-five-minutes
bash deploy.sh
```

脚本会执行 `git pull`、`npm install`、`npm run check`、创建运行目录、PM2 reload，并保存 PM2 状态。脚本不会删除 `data`，也不会覆盖 `.env`。

## 11. SQLite 数据备份

手动备份：

```bash
cd /opt/afterwork-five-minutes
npm run backup
```

建议添加 cron 定时任务：

```bash
crontab -e
```

加入：

```cron
0 3 * * * cd /opt/afterwork-five-minutes && /usr/bin/npm run backup >> /opt/afterwork-five-minutes/logs/backup.log 2>&1
```

备份文件会写入 `backups/snapshot-*`。建议同时使用阿里云磁盘快照或 OSS 做异地备份。

## 12. 常见问题排查

### 访问域名打不开

```bash
sudo nginx -t
sudo systemctl status nginx
pm2 status
curl http://127.0.0.1:4173/api/health
```

同时检查阿里云安全组是否开放 80/443，域名 A 记录是否指向 ECS 公网 IP。

### PM2 启动失败

```bash
node -v
pm2 logs afterwork-five-minutes
npm run check
```

本项目要求 Node.js 24+，低版本可能无法使用 `node:sqlite`。

### 登录后刷新变成未登录

确认 HTTPS 已生效，并且 `.env` 中 `COOKIE_SECURE=true`。如果只是在 HTTP 阶段临时测试，可以先设为 `COOKIE_SECURE=false`，正式 HTTPS 后再改回 `true` 并重启 PM2。

### AI 或语音不可用

```bash
curl http://127.0.0.1:4173/api/health
```

检查 `.env` 里的 `AI_API_KEY`、`BAIDU_API_KEY`、`BAIDU_SECRET_KEY` 是否填写，服务器是否能访问对应云服务接口。

### 数据丢失或新用户看不到旧数据

确认 `DATA_DIR=/opt/afterwork-five-minutes/data`，并检查 `data/auth.sqlite`、`data/users/*.sqlite` 是否存在。部署更新时不要删除 `data` 目录。
