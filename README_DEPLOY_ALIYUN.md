# 阿里云 ECS 部署通用指南

这份文档给非专业开发者使用，适用于大多数全栈网站：Node.js 后端、静态或前端框架、数据库、Nginx、PM2、域名和 HTTPS。

## 部署信息表

### 基础信息

| 项目 | 填写 |
| --- | --- |
| 项目名称 |  |
| GitHub 仓库地址 |  |
| 服务器公网 IP |  |
| 服务器系统 | Ubuntu 22.04 / 24.04 |
| 部署目录 | `/opt/<项目名>` |
| 域名 |  |
| Node.js 版本 | 24+ |
| 包管理器 | npm / pnpm / yarn |

### 应用信息

| 项目 | 填写 |
| --- | --- |
| 前端端口 |  |
| 后端端口 |  |
| 生产启动命令 |  |
| 构建命令 |  |
| PM2 应用名 |  |

### 数据库信息

| 项目 | 填写 |
| --- | --- |
| 数据库类型 | MySQL / PostgreSQL / MongoDB / SQLite |
| 数据库部署位置 | 阿里云 RDS / ECS 本机 / Supabase / 其他 |
| 数据库连接变量名 | `DATABASE_URL` 等 |
| 是否需要迁移 | 是 / 否 |
| 迁移命令 |  |

### 域名与 SSL

| 项目 | 填写 |
| --- | --- |
| 域名解析状态 | 未配置 / 已解析 |
| Nginx 配置文件路径 | `/etc/nginx/sites-available/<项目名>.conf` |
| SSL 证书路径 | Certbot 自动管理 |
| HTTPS 是否完成 | 是 / 否 |

## 1. 准备阿里云服务器

建议购买 Ubuntu 22.04 或 24.04 ECS。小型项目可从 2 vCPU / 2GB 内存起步。安全组至少开放：

- 22：SSH
- 80：HTTP
- 443：HTTPS

应用端口通常只监听 `127.0.0.1`，不需要在安全组对公网开放。

## 2. 安装基础环境

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

如项目使用 pnpm：

```bash
corepack enable
pnpm -v
```

## 3. 拉取项目

```bash
sudo mkdir -p /opt/<项目名>
sudo chown -R "$USER":"$USER" /opt/<项目名>
git clone <GitHub 仓库地址> /opt/<项目名>
cd /opt/<项目名>
```

## 4. 创建生产环境变量

```bash
cp .env.production.example .env
nano .env
chmod 600 .env
```

只在服务器 `.env` 填真实密钥。不要把 `.env` 上传到 GitHub。

常见变量：

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?schema=public
JWT_SECRET=replace-with-a-long-random-secret
API_BASE_URL=https://example.com
```

## 5. 安装、构建、迁移

```bash
npm install
npm run build
```

如果使用 Prisma：

```bash
npx prisma generate
npx prisma migrate deploy
```

如果使用 SQL 文件：

```bash
mysql -u <user> -p <database> < ./migrations/init.sql
psql "$DATABASE_URL" -f ./migrations/init.sql
```

## 6. 启动 PM2

```bash
mkdir -p logs backups data
pm2 startOrReload ecosystem.config.js --env production
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u "$USER" --hp "$HOME"
```

检查：

```bash
pm2 status
pm2 logs <应用名>
curl http://127.0.0.1:<端口>/api/health
```

## 7. 配置 Nginx

```bash
sudo cp nginx.conf /etc/nginx/sites-available/<项目名>.conf
sudo ln -sf /etc/nginx/sites-available/<项目名>.conf /etc/nginx/sites-enabled/<项目名>.conf
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 关键配置：

```nginx
server {
    listen 80;
    server_name example.com www.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 8. 配置域名解析

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

## 9. 配置 HTTPS

域名解析生效后安装 Certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com -d www.example.com
sudo certbot renew --dry-run
```

HTTPS 完成后，如果应用使用安全 Cookie，把 `.env` 中的安全 Cookie 开关改为 true，例如：

```env
COOKIE_SECURE=true
```

然后重启：

```bash
pm2 restart <应用名> --update-env
```

## 10. 上线检查表

- [ ] 网站首页可访问。
- [ ] 登录功能可用。
- [ ] 主要接口可访问。
- [ ] 数据库写入和读取可用。
- [ ] 移动端访问无明显布局问题。
- [ ] PM2 服务在线。
- [ ] Nginx 配置通过。
- [ ] HTTPS 可用并能自动续期。
- [ ] `.env` 没有提交到 GitHub。
- [ ] 数据库和上传文件有备份方案。

## 11. 常见问题

### 502 Bad Gateway

```bash
pm2 status
pm2 logs <应用名>
sudo ss -ltnp | grep <端口>
sudo nginx -t
sudo tail -n 80 /var/log/nginx/error.log
```

### 端口没有监听

检查 `.env`、`ecosystem.config.js` 和代码是否读取 `process.env.PORT`。重启：

```bash
pm2 restart <应用名> --update-env
```

### 数据库连接失败

检查 `DATABASE_URL`，确认 RDS 白名单/安全组允许 ECS 访问。不要把数据库端口直接开放给公网。

### npm build 失败

检查 Node 版本、包管理器、lockfile 和构建时环境变量。

### Nginx 配置错误

```bash
sudo nginx -t
sudo nginx -T | grep -n "server_name\\|proxy_pass\\|listen"
```

### 域名未生效

```bash
dig +short example.com
curl -H "Host: example.com" http://<ECS公网IP>/
```

### HTTPS 证书错误

```bash
sudo certbot certificates
sudo certbot renew --dry-run
sudo nginx -t
```

## 12. 回滚

回滚前先备份数据库和上传文件：

```bash
cd /opt/<项目名>
git log --oneline -5
git checkout <上一个commit>
npm install
npm run build
pm2 restart <应用名> --update-env
sudo nginx -t && sudo systemctl reload nginx
```

如果数据库迁移不可逆，必须从备份恢复，或者执行已经验证过的 down migration。
