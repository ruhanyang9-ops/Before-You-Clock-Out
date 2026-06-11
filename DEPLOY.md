# 下班前五分钟部署说明

## 本地启动

要求 Node.js 24 或更高版本。

```bash
node server.js
```

开启 DeepSeek 真实 AI：

```bash
AI_API_KEY="你的key" AI_MODEL="deepseek-v4-flash" node server.js
```

也可以复制 `.env.example` 为 `.env` 后填写密钥，服务启动时会自动加载 `.env`。未配置 `AI_API_KEY` / `DEEPSEEK_API_KEY` 时，应用会自动使用 mock / 本地规则模式。应用内置邮箱 + 密码个人账号登录，不再依赖访问口令作为主要登录方式。

如果浏览器语音识别提示网络不可用，可以额外配置百度智能云语音识别：

```bash
BAIDU_API_KEY="你的百度API Key" BAIDU_SECRET_KEY="你的百度Secret Key" BAIDU_DEV_PID="1537" node server.js
```

也可以配置 OpenAI-compatible 语音转文字服务：

```bash
STT_API_KEY="你的语音转写key" STT_BASE_URL="https://api.openai.com/v1" STT_MODEL="whisper-1" node server.js
```

DeepSeek 用于工作记录整理和总结生成；语音转文字需要单独的 STT 服务。百度模式下，前端会录制 16k 单声道 WAV 后上传到本地后端，再由后端调用百度识别接口。

## 云服务器建议

- Ubuntu 22.04 / 24.04
- Node.js 24+
- SQLite 本地文件：`data/auth.sqlite`、`data/users/*.sqlite`
- Caddy 或 Nginx 反向代理 HTTPS
- systemd 负责进程保活

建议部署目录：

```text
/opt/afterwork-five-minutes/
├── app.js
├── aiService.js
├── server.js
├── index.html
├── styles.css
├── package.json
├── scripts/
└── data/
    ├── auth.sqlite
    └── users/
        └── user_xxx.sqlite
```

## systemd 示例

创建 `/etc/systemd/system/afterwork-five-minutes.service`：

```ini
[Unit]
Description=Afterwork Five Minutes
After=network.target

[Service]
WorkingDirectory=/opt/afterwork-five-minutes
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=HOST=127.0.0.1
Environment=PORT=4173
Environment=AI_API_KEY=请替换为你的key
Environment=AI_MODEL=deepseek-v4-flash

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now afterwork-five-minutes
sudo systemctl status afterwork-five-minutes
```

## Caddy HTTPS 示例

```caddyfile
five.example.com {
  reverse_proxy 127.0.0.1:4173
}
```

## SQLite 备份

手动备份：

```bash
node scripts/backup-sqlite.js
```

定时备份可用 cron：

```cron
0 3 * * * cd /opt/afterwork-five-minutes && /usr/bin/node scripts/backup-sqlite.js >> /var/log/afterwork-five-minutes-backup.log 2>&1
```

默认保留最近 14 天备份，可用 `BACKUP_KEEP_DAYS=7` 调整。

## 健康检查

服务启动后可访问：

```text
http://127.0.0.1:4173/api/health
```

该接口返回账号库、用户库、AI 和语音接口配置状态，不返回任何密钥。
