# 提取笔记（Tencent/openclaw-weixin v2.4.6）

源仓库：https://github.com/Tencent/openclaw-weixin — **MIT License**（可自由提取/复用，保留版权声明）。
本文件记录从插件源码中核实到的协议事实，作为 `src/wechat/` 移植的权威参考。

## 常量

| 名称 | 值 |
|------|-----|
| 默认网关 | `https://ilinkai.weixin.qq.com`（QR 也用同一 `FIXED_BASE_URL`） |
| CDN | `https://novac2c.cdn.weixin.qq.com/c2c` |
| `ilink_appid` | `bot`（package.json 顶层字段，作 `iLink-App-Id` 请求头） |
| bot_type | `"3"` |
| client version | `0x00MMNNPP`（版本号 major<<16|minor<<8|patch） |

## 请求头

- `Content-Type: application/json`
- `AuthorizationType: ilink_bot_token`
- `Authorization: Bearer <token>`（登录后才有）
- `X-WECHAT-UIN`: 随机 uint32 → 十进制字符串 → base64
- `iLink-App-Id: bot`
- `iLink-App-ClientVersion: <uint32>`
- `SKRouteTag`（可选，来自配置）

每请求带 `base_info: { channel_version, bot_agent }`。

## 端点

| 用途 | 路径 | 方法 | 鉴权 |
|------|------|------|------|
| 取二维码 | `ilink/bot/get_bot_qrcode?bot_type=3` | POST(body: `{local_token_list}`) | 无 |
| 轮询扫码状态 | `ilink/bot/get_qrcode_status?qrcode=<q>[&verify_code=]` | GET 长轮询 35s | 无 |
| 收消息 | `ilink/bot/getupdates` | POST 长轮询 | token |
| 发消息 | `ilink/bot/sendmessage` | POST | token |
| 上传预签名 | `ilink/bot/getuploadurl` | POST | token |
| 取配置(typing_ticket) | `ilink/bot/getconfig` | POST | token |
| 输入状态 | `ilink/bot/sendtyping` | POST | token |
| 启停通知 | `ilink/bot/msg/notifystart` / `notifystop` | POST | token |

## 登录流程

1. `get_bot_qrcode?bot_type=3` → `{ qrcode, qrcode_img_content }`（img_content 是链接/二维码内容）。
2. 轮询 `get_qrcode_status`，状态机：`wait / scaned / confirmed / expired / scaned_but_redirect(IDC 重定向，更新 baseUrl) / need_verifycode(配对码) / verify_code_blocked / binded_redirect(已绑定)`。
3. `confirmed` → `{ bot_token, ilink_bot_id(accountId), baseurl, ilink_user_id }`。
4. 存 `token` + `baseUrl`；后续请求用 `Authorization: Bearer <token>`。

## 消息流

**收**：`getupdates` → `{ ret, msgs: WeixinMessage[], get_updates_buf, longpolling_timeout_ms }`。
- `WeixinMessage`: `from_user_id / to_user_id / item_list / context_token / group_id(群聊，忽略) / run_id`。
- `item_list`: `MessageItem { type, text_item, image_item, voice_item, file_item, video_item, ref_msg }`。
- 文本提取：`item_list` 里 `type==TEXT` 的 `text_item.text`（含引用消息处理）；语音转文字取 `voice_item.text`。
- 游标：`get_updates_buf` 需持久化并在下次请求回传。
- `context_token`：按 (accountId, userId) 持久化，**发消息时必须原样回传**。

**发**：`sendmessage`，body：
```json
{ "msg": { "to_user_id": "<id>", "client_id": "<随机>", "message_type": 2,
           "message_state": 2, "item_list": [{ "type": 1, "text_item": { "text": "..." } }],
           "context_token": "<回传>", "run_id": "<可选>" } }
```

## 收图解密

- 图片：`image_item.media.{encrypt_query_param, full_url, aes_key}` 或顶层 `image_item.aeskey`（hex 16 字节）。
- AES key 两种编码：`base64(16 raw bytes)`（图）或 `base64(32 hex chars)`（file/voice/video）。
- 下载：优先 `media.full_url`，否则 `{cdn}/download?encrypted_query_param=...`。
- 解密：AES-128-ECB（PKCS7）。见 `aes-ecb.ts` / `pic-decrypt.ts`。

## 文件映射：保留 vs 剥离

**保留（无 OpenClaw 依赖，直接移植）**：
- `src/api/api.ts`（iLink 客户端）、`src/api/types.ts`（协议类型）
- `src/auth/login-qr.ts`（扫码登录）
- `src/cdn/{aes-ecb,cdn-url,pic-decrypt,cdn-upload}.ts`（加解密/CDN）
- `src/media/media-download.ts`（收媒体解密；只保留 IMAGE 分支）
- `src/messaging/inbound.ts`（context token 存储 + 消息→上下文）、`src/messaging/send.ts`（发文本）
- `src/storage/sync-buf.ts`（游标持久化）
- `src/util/{logger,redact,random}.ts`

**剥离（OpenClaw 耦合，用我们的实现替换）**：
- `src/channel.ts`（`ChannelPlugin` 对象 → 换成服务 wiring）
- `src/monitor/monitor.ts`（轮询循环 → 保留循环形状，`processOneMessage` 换成 Pi dispatch）
- `src/messaging/process-message.ts`（OpenClaw agent 管道 → 换成 Pi）
- `src/messaging/{outbound-hooks,send-media,markdown-filter,reply-progress-sender,error-notice,debug-mode,slash-commands}.ts`
- `src/auth/{pairing,account-index,account-store}.ts`、`src/api/config-cache.ts`、`src/api/session-guard.ts`

**需要替换的 OpenClaw SDK 依赖**：
- `normalizeAccountId`（`openclaw/plugin-sdk/account-id`）→ 简单 `@`→`-` 替换
- `resolveStateDir`（`storage/state-dir.ts`）→ 我们的状态目录
- `loadConfigBotAgent / loadConfigRouteTag / OpenClawConfig` → 我们的 `config.ts`
- `saveMedia`（媒体落盘）→ 我们的临时文件函数
