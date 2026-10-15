import { createAgentGateway } from "./channels/agent-gateway.js";
import { getBindingByAccount } from "./db/index.js";
import { resolveWeixinAccount } from "./wechat/accounts.js";
import { getContextToken } from "./wechat/context-token.js";
import type { InboundContext } from "./wechat/inbound.js";
import { sendTextChunked } from "./wechat/send.js";
import { TypingSession } from "./wechat/typing.js";

/**
 * WeChat transport adapter. Routes each bot account's inbound messages into the
 * transport-agnostic agent gateway (channels/agent-gateway.ts) and sends replies
 * back through iLink. All routing/policy/turn logic lives in the gateway, so a
 * new channel only needs to provide a reply sink.
 */
export function createBotHandler(): (ctx: InboundContext) => Promise<void> {
  const gateway = createAgentGateway({
    resolveUserId: (message) => getBindingByAccount(message.accountId)?.userId ?? null,
    onUnbound: async (_message, reply) => {
      await reply.text("此 Bot 账号尚未绑定用户，请联系管理员完成绑定。");
    },
  });

  return async (ctx) => {
    const account = resolveWeixinAccount(ctx.accountId);
    const contextToken = ctx.contextToken ?? getContextToken(ctx.accountId, ctx.from);

    const send = (text: string): Promise<void> =>
      sendTextChunked({
        to: ctx.from,
        text,
        opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
      }).then(() => undefined);

    const typing = new TypingSession({
      baseUrl: account.baseUrl,
      token: account.token,
      wechatUserId: ctx.from,
      contextToken,
    });

    await gateway(
      {
        channelId: "wechat",
        accountId: ctx.accountId,
        senderId: ctx.from,
        text: ctx.body,
        media: ctx.media,
        contextToken,
      },
      {
        text: send,
        startTyping: () => typing.start(),
        stopTyping: () => typing.stop(),
      },
    );
  };
}
