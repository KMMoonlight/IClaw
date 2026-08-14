import { initSharedTools } from "./agent/runtime.js";
import { DEFAULT_BASE_URL, DEFAULT_BOT_TYPE } from "./config.js";
import { createBotHandler } from "./bot.js";
import { startServer } from "./server/app.js";
import { createInvite, createUser } from "./db/index.js";
import { generateInviteCode } from "./random.js";
import {
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  normalizeAccountId,
  registerWeixinAccountId,
  resolveWeixinAccount,
  saveWeixinAccount,
} from "./wechat/accounts.js";
import { startWechatChannel } from "./wechat/channel.js";
import { getContextToken } from "./wechat/context-token.js";
import type { InboundContext } from "./wechat/inbound.js";
import { displayQRCode, startWeixinLoginWithQr, waitForWeixinLogin } from "./wechat/login-qr.js";
import { sendTextMessage } from "./wechat/send.js";

const USAGE = `IClaw — WeChat <-> Pi Agent bridge

Usage:
  iclaw login [accountId]   Start QR-code login for the bot WeChat account
  iclaw run                 Start the bot (Pi agent + invite flow)
  iclaw echo                Start the channel in echo mode (channel test, no AI)
  iclaw create-user <name>  Create a user + print an invite code
  iclaw status              Show registered accounts
  iclaw serve               Start the web admin server (Phase 4)
`;

async function login(accountId?: string): Promise<number> {
  const start = await startWeixinLoginWithQr({
    accountId,
    apiBaseUrl: DEFAULT_BASE_URL,
    botType: DEFAULT_BOT_TYPE,
  });
  if (!start.qrcodeUrl) {
    process.stderr.write(start.message + "\n");
    return 1;
  }
  await displayQRCode(start.qrcodeUrl);

  const wait = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: DEFAULT_BASE_URL,
    timeoutMs: 480_000,
    botType: DEFAULT_BOT_TYPE,
  });

  if (wait.connected && wait.botToken && wait.accountId) {
    const id = normalizeAccountId(wait.accountId);
    saveWeixinAccount(id, { token: wait.botToken, baseUrl: wait.baseUrl, userId: wait.userId });
    registerWeixinAccountId(id);
    process.stdout.write(`\n✅ 已连接到微信。accountId=${id}\n`);
    return 0;
  }
  if (wait.alreadyConnected) {
    process.stdout.write(wait.message + "\n");
    return 0;
  }
  process.stderr.write(wait.message + "\n");
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

async function startChannel(handler: (ctx: InboundContext) => Promise<void>): Promise<number> {
  const ids = listIndexedWeixinAccountIds();
  if (ids.length === 0) {
    process.stderr.write("未找到已登录账号，请先运行 `iclaw login`。\n");
    return 1;
  }
  const abort = new AbortController();
  const shutdown = () => abort.abort();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await startWechatChannel({ onMessage: handler, abortSignal: abort.signal });
  return 0;
}

async function run(): Promise<number> {
  await initSharedTools();
  return startChannel(createBotHandler());
}

async function echo(): Promise<number> {
  return startChannel(echoHandler());
}

async function createUserCmd(name: string): Promise<number> {
  if (!name) {
    process.stderr.write("用法：iclaw create-user <name>\n");
    return 1;
  }
  const user = createUser(name);
  const code = generateInviteCode();
  createInvite(code, user.id);
  process.stdout.write(`已创建用户：${user.name} (id=${user.id})\n`);
  process.stdout.write(`邀请码：${code}\n`);
  process.stdout.write(`让该用户给机器人发送此邀请码即可绑定。\n`);
  return 0;
}

async function serve(): Promise<number> {
  await startServer();
  return 0;
}

async function status(): Promise<number> {
  const ids = listIndexedWeixinAccountIds();
  if (ids.length === 0) {
    process.stdout.write("无已注册账号。\n");
    return 0;
  }
  for (const id of ids) {
    const data = loadWeixinAccount(id);
    process.stdout.write(`accountId=${id} configured=${Boolean(data?.token)} baseUrl=${data?.baseUrl ?? "(default)"}\n`);
  }
  return 0;
}

async function main(): Promise<number> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "login":
      return login(arg);
    case "run":
      return run();
    case "echo":
      return echo();
    case "create-user":
      return createUserCmd(arg ?? "");
    case "serve":
      return serve();
    case "status":
      return status();
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
