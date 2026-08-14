# IClaw 部署教程

IClaw 是单进程 Node 服务：Web 管理端 + 每个已绑定用户的微信长轮询通道都在一个进程里。
微信通道**只发出站 HTTPS 长轮询**（连腾讯 iLink 网关），不需要任何入站端口；入站只需要
管理端的 HTTP（3000 端口）。

## 0. 前置要求

- 一台 7×24 在线的机器（VPS / NAS / 家里的常开主机均可），能访问外网
  （`ilinkai.weixin.qq.com`、模型 API、微信 CDN）。
- Node.js ≥ 22.13（`node:sqlite` 免 flag），或 Docker。
- （可选）一个域名 + HTTPS 证书，用于安全访问管理端。

## 1. 配置 `.env`

```bash
cp .env.example .env
```

必填：`ICLAW_MODEL_PROVIDER`、`ICLAW_MODEL`、`ICLAW_API_KEY`。
强烈建议设置 `ICLAW_ADMIN_PASSWORD`（权威密码，每次启动同步到库）。

## 2. 部署方式 A：Docker Compose（推荐）

```bash
docker compose up -d --build
docker compose logs -f iclaw     # 首次启动日志里会打印管理员密码（若未设 ICLAW_ADMIN_PASSWORD）
```

- 状态数据在 `./data/`（SQLite + 微信凭证），已挂载持久卷；**备份 = 备份这个目录 + `.env`**。
- 健康检查：`http://127.0.0.1:3000/api/health`。
- 升级：`git pull && docker compose up -d --build`。

## 3. 部署方式 B：裸机 + systemd（无 Docker）

```bash
git clone <repo> /opt/iclaw && cd /opt/iclaw
npm ci
npm run build && npm run web:build
```

创建 `/etc/systemd/system/iclaw.service`：

```ini
[Unit]
Description=IClaw WeChat <-> Pi Agent bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/iclaw
EnvironmentFile=/opt/iclaw/.env
ExecStart=/usr/bin/node dist/server/index.js
Restart=always
RestartSec=5
# 硬性资源上限（可选）
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now iclaw
journalctl -u iclaw -f        # 看日志（含首次管理员密码）
```

升级：`git pull && npm ci && npm run build && npm run web:build && systemctl restart iclaw`。

## 4. 对外暴露管理端（可选）

默认管理端只监听 `127.0.0.1:3000`，最安全的远程访问方式是 **SSH 隧道**：

```bash
ssh -L 3000:127.0.0.1:3000 user@server
```

要直接对外，则配 HTTPS 反向代理（以 Caddy 为例，自动签证书）：

```
iclaw.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

同时在 `.env` 里设置：

```ini
ICLAW_SERVER_HOST=0.0.0.0     # 或保持 127.0.0.1 只让反代转发
ICLAW_COOKIE_SECURE=true     # HTTPS 下会话 cookie 加 Secure 标志
```

> 不要在没有 HTTPS 的情况下把管理端裸暴露到公网——管理员会话 cookie 会明文传输。

## 5. 首次上线清单

1. 打开管理端 → 用管理员账号登录。
2. 「用户」页新建用户 → 点「绑定二维码」→ 把二维码截图发给该用户（**二维码 5 分钟有效**，
   过期会自动刷新，重新截图即可）。
3. 用户用手机微信扫码并确认 → 其微信出现专属 Bot 好友 → 发条消息测试 AI 回复
   （回复期间对方会看到"正在输入…"）。
4. 有问题时看日志：`docker compose logs -f` 或 `journalctl -u iclaw -f`。
5. 给用户讲两个命令：发 `/new` 开启新会话；管理员可随时在 Web 冻结用户。

## 6. 运维

**备份**（务必定期做，微信登录凭证不可重新推导）：

```bash
tar czf iclaw-backup-$(date +%F).tar.gz .env data/
```

**token 失效**：微信 token 失效后通道日志会报 `token is stale`，让该用户在 Web 点「重新绑定」
重新扫码即可（解绑会删除本地凭证）。

**多账号**：每个用户各绑定一个 bot 账号，互不影响；`iclaw status` 可看绑定关系。

## 7. 常见问题

| 现象 | 处理 |
|------|------|
| 管理端 401 凭证错误 | 重启服务（`ICLAW_ADMIN_PASSWORD` 每次启动同步），或 `npm run reset-admin-password -- <新密码>` |
| 绑定弹窗报 Bad Request | 拉最新代码并重建前端（`npm run web:build` / 重建镜像） |
| 发消息没回复 | 看日志：模型 key/网络错误会记在 stderr；被冻结用户消息会被静默忽略 |
| 图片/媒体收不到 | 需要模型支持图片（`ICLAW_MODEL_SUPPORTS_IMAGES=true`），纯文本模型会把图片转成文字提示 |
| SQLite 目录权限 | 容器内挂载目录需可写；裸机注意 systemd 用户权限 |

## 8. ⚠️ 合规与封号风险

本项目走腾讯官方 iLink 网关，但本质仍是「个人微信账号自动化」，每个用户绑定的是其**本人的
微信号**。请确保用户知情同意，控制使用规模，并自行评估微信相关条款。`botAgent` 自报
`IClaw/1.0`，未伪装官方客户端。
