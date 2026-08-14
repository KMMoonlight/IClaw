import { initSharedTools } from "./agent/runtime.js";
import { createBotHandler } from "./bot.js";
import { startServer } from "./server/app.js";
import { hashPassword } from "./server/auth.js";
import { loadConfig } from "./config.js";
import { createUser, getAdminByUsername, listBotBindings, setAdminPassword } from "./db/index.js";
import { persistAndBind } from "./wechat/binding.js";
import { runBindSession } from "./wechat/bind-driver.js";
import {
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  normalizeAccountId,
  registerWeixinAccountId,
  resolveWeixinAccount,
  saveWeixinAccount,
} from "./wechat/accounts.js";
import {
  startAllRegisteredChannels,
  startChannelsForBoundAccounts,
  waitForAllChannels,
} from "./wechat/channel.js";
import { getContextToken } from "./wechat/context-token.js";
import type { InboundContext } from "./wechat/inbound.js";
import { displayQRCode, getLoginSession, submitVerifyCode } from "./wechat/login-qr.js";
import type { LoginSession } from "./wechat/login-qr.js";
import { sendTextMessage } from "./wechat/send.js";

const USAGE = `IClaw — WeChat <-> Pi Agent bridge

Usage:
  iclaw login [accountId]   测试/备用：扫码登录一个 bot 微信账号（不绑定用户）
  iclaw bind <name>         创建用户并扫码绑定（该用户微信里会出现专属 Bot 好友）
  iclaw create-user <name>  仅创建用户（在 Web 端为该用户生成绑定二维码）
  iclaw run                 启动 bot：为每个已绑定用户的 bot 账号各起一条通道
  iclaw echo                回显模式：全部已注册账号，通道测试，不调 AI
  iclaw status              查看已注册账号与绑定关系
  iclaw reset-admin-password <new-password>
                            重置管理员密码（也可在 .env 设 ICLAW_ADMIN_PASSWORD 后重启）
  iclaw serve               启动 Web 管理端 + 微信通道
`;

// ---------------------------------------------------------------------------
// QR session helpers（CLI 驱动：stdin 输入配对码）
// ---------------------------------------------------------------------------

function readStdinLines(onLine: (line: string) => void): { close: () => void } {
  let buffer = "";
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) onLine(line);
    }
  };
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", onData);
  return {
    close: () => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
    },
  };
}

async function runQrSession(
  key: string,
  onConnected: (session: LoginSession) => Promise<void>,
): Promise<LoginSession> {
  let lastQr: string | undefined;
  let lastPhase: LoginSession["phase"] | undefined;
  const stdin = readStdinLines((line) => {
    const s = getLoginSession(key);
    if (s?.phase === "need_verifycode") submitVerifyCode(key, line);
  });
  try {
    return await runBindSession({
      key,
      onStateChange: (s) => {
        if (s.qrcodeUrl && s.qrcodeUrl !== lastQr) {
          lastQr = s.qrcodeUrl;
          void displayQRCode(s.qrcodeUrl);
        }
        if (s.phase !== lastPhase) {
          lastPhase = s.phase;
          if (s.phase === "scanned" || s.phase === "need_verifycode") {
            process.stdout.write(`\n${s.message}\n`);
          }
        }
      },
      onConnected,
    });
  } finally {
    stdin.close();
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function login(accountId?: string): Promise<number> {
  const key = accountId?.trim() || `cli-login-${Date.now()}`;
  const session = await runQrSession(key, async (s) => {
    if (s.accountId && s.botToken) {
      const id = normalizeAccountId(s.accountId);
      saveWeixinAccount(id, { token: s.botToken, baseUrl: s.baseUrl, userId: s.wechatUserId });
      registerWeixinAccountId(id);
    }
  });
  if (session.connected && session.accountId) {
    process.stdout.write(`\n✅ 已连接到微信。accountId=${normalizeAccountId(session.accountId)}\n`);
    return 0;
  }
  if (session.phase === "already_connected") {
    process.stdout.write(session.message + "\n");
    return 0;
  }
  process.stderr.write(session.message + "\n");
  return 1;
}

async function bind(name: string): Promise<number> {
  if (!name) {
    process.stderr.write("用法：iclaw bind <name>\n");
    return 1;
  }
  const user = createUser(name);
  process.stdout.write(`已创建用户：${user.name} (id=${user.id})\n`);
  process.stdout.write("请让该用户用手机微信扫描下方二维码。\n");
  process.stdout.write("扫码确认后，其微信中会出现一个专属 Bot 好友，与之聊天即与 Pi 对话。\n");

  const key = `user-${user.id}`;
  const session = await runQrSession(key, async (s) => {
    persistAndBind(s, user.id);
  });

  if (session.connected && session.accountId) {
    process.stdout.write(`\n✅ 绑定成功：${user.name} ↔ bot 账号 ${normalizeAccountId(session.accountId)}\n`);
    process.stdout.write("启动服务后生效：iclaw serve 或 iclaw run\n");
    return 0;
  }
  process.stderr.write(`\n${session.message}\n`);
  return 1;
}

function echoHandler(): (ctx: InboundContext) => Promise<void> {
  return async (ctx) => {
    const account = resolveWeixinAccount(ctx.accountId);
    const text = ctx.media ? `[收到图片] ${ctx.body}` : ctx.body;
    const contextToken = ctx.contextToken ?? getContextToken(account.accountId, ctx.from);
    await sendTextMessage({
      to: ctx.from,
      text: text || "(empty)",
      opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
    });
  };
}

async function startChannel(command: "run" | "echo", handler: (ctx: InboundContext) => Promise<void>): Promise<number> {
  const abort = new AbortController();
  const shutdown = () => abort.abort();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (command === "echo") {
    try {
      startAllRegisteredChannels(handler);
    } catch (err) {
      process.stderr.write(`${String(err)}\n`);
      return 1;
    }
  } else {
    const started = startChannelsForBoundAccounts(handler);
    if (started === 0) {
      process.stderr.write("没有已绑定的用户，请先在 Web 端生成绑定二维码或运行 `iclaw bind <name>`。\n");
      return 1;
    }
  }
  await waitForAllChannels();
  return 0;
}

async function run(): Promise<number> {
  await initSharedTools();
  return startChannel("run", createBotHandler());
}

async function echo(): Promise<number> {
  return startChannel("echo", echoHandler());
}

async function createUserCmd(name: string): Promise<number> {
  if (!name) {
    process.stderr.write("用法：iclaw create-user <name>\n");
    return 1;
  }
  const user = createUser(name);
  process.stdout.write(`已创建用户：${user.name} (id=${user.id})\n`);
  process.stdout.write("请在 Web 管理端为该用户生成绑定二维码，或运行 `iclaw bind`。\n");
  return 0;
}

async function resetAdminPassword(newPassword: string): Promise<number> {
  if (!newPassword) {
    process.stderr.write("用法：iclaw reset-admin-password <new-password>\n");
    return 1;
  }
  const cfg = loadConfig();
  const admin = getAdminByUsername(cfg.adminUser);
  if (!admin) {
    process.stderr.write("未找到管理员账号（先运行 iclaw serve 创建，或在 .env 设 ICLAW_ADMIN_PASSWORD 后启动）。\n");
    return 1;
  }
  setAdminPassword(cfg.adminUser, hashPassword(newPassword));
  process.stdout.write("已更新管理员密码。\n");
  return 0;
}

async function serve(): Promise<number> {
  await startServer();
  return 0;
}

async function status(): Promise<number> {
  const ids = listIndexedWeixinAccountIds();
  const bindings = listBotBindings();
  if (ids.length === 0 && bindings.length === 0) {
    process.stdout.write("无已注册账号，也没有绑定记录。\n");
    return 0;
  }
  for (const id of ids) {
    const data = loadWeixinAccount(id);
    const binding = bindings.find((b) => b.accountId === id);
    const bound = binding ? `boundTo=${binding.userId} wechat=${binding.wechatUserId || "?"}` : "unbound";
    process.stdout.write(`accountId=${id} configured=${Boolean(data?.token)} ${bound}\n`);
  }
  for (const b of bindings) {
    if (!ids.includes(b.accountId)) {
      process.stdout.write(`accountId=${b.accountId} configured=false boundTo=${b.userId} wechat=${b.wechatUserId || "?"}\n`);
    }
  }
  return 0;
}

async function main(): Promise<number> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "login":
      return login(arg);
    case "bind":
      return bind(arg ?? "");
    case "create-user":
      return createUserCmd(arg ?? "");
    case "run":
      return run();
    case "echo":
      return echo();
    case "serve":
      return serve();
    case "status":
      return status();
    case "reset-admin-password":
      return resetAdminPassword(arg ?? "");
    default:
      process.stdout.write(USAGE);
      return cmd ? 1 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err?.stack ?? String(err)}\n`);
    process.exit(1);
  },
);
