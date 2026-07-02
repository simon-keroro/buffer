
# buffer
长效八缓冲液配制
# 长效八缓冲液配制量计算 APP

这是带多人共享保存功能的版本。页面仍然是原来的 Web APP，服务器负责保存共享数据：

- 管洗用量、取样量、配制量会保存到服务器。
- 柱高会保存到服务器，因此不同电脑看到的理论量一致。
- “计算依据”里的 CV、固定 kg、说明文字可以直接编辑，修改后会重新计算并同步。

## 本地运行

```bash
npm start
```

打开：

```text
http://localhost:3000
```

共享数据保存在 `data/state.json`。这个文件不要提交到 GitHub，已经写进 `.gitignore`。

## GitHub 设置

第一次提交到 `simon-keroro/buffer`：

```bash
git init
git add .
git commit -m "Add shared buffer calculation app"
git branch -M main
git remote add origin git@github.com:simon-keroro/buffer.git
git push -u origin main
```

如果你用 HTTPS：

```bash
git remote add origin https://github.com/simon-keroro/buffer.git
```

## VPS 部署

服务器安装 Node.js 20 或更高版本后：

```bash
git clone git@github.com:simon-keroro/buffer.git
cd buffer
npm start
```

建议用 `systemd` 常驻运行，例如创建 `/etc/systemd/system/buffer-app.service`：

```ini
[Unit]
Description=Long8 Buffer App
After=network.target

[Service]
WorkingDirectory=/opt/buffer
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3000
Environment=APP_USER=buffer
Environment=APP_PASSWORD=请替换成强密码

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now buffer-app
```

如果用 Nginx 反向代理到域名，核心配置：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
```

生产环境建议配置 HTTPS，并设置 `APP_PASSWORD`，避免外部人员直接修改数据。
