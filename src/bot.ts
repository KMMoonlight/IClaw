import { runAgentTurn } from "./agent/runtime.js";
import {
  bindWechat,
  getBindingByWechat,
  getInvite,
  getUser,
  markInviteUsed,
} from "./db/index.js";
import { resolveWeixinAccount } from "./wechat/accounts.js";
import { getContextToken } from "./wechat/context-token.js";
import type { InboundContext } from "./wechat/inbound.js";
import { sendTextMessage } from "./wechat/send.js";

/**
 * The bot's inbound handler: route by binding, run the agent for known users,
 * and drive the invite flow for unknown ones.
 */
export function createBotHandler(): (ctx: InboundContext) => Promise<void> {
  return async (ctx) => {
    const account = resolveWeixinAccount(ctx.accountId);
    const contextToken = ctx.contextToken ?? getContextToken(ctx.accountId, ctx.from);
    const send = (text: string) =>
      sendTextMessage({
        to: ctx.from,
        text,
        opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
      });

    const binding = getBindingByWechat(ctx.from);
    if (binding) {
      const user = getUser(binding.userId);
      if (!user || user.status !== "active") return; // frozen or missing → silent
      try {
        const reply = await runAgentTurn(user.id, ctx);
        if (reply) await send(reply);
      } catch (err) {
        await send(`处理出错：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // Unbound sender → invite flow.
    const code = ctx.body.trim();
    const invite = code ? getInvite(code.toUpperCase()) : null;
    if (invite && invite.status === "pending" && invite.userId) {
      bindWechat(ctx.from, invite.userId, ctx.accountId);
      markInviteUsed(invite.code, invite.userId);
      const user = getUser(invite.userId);
      await send(`✅ 绑定成功${user ? `，欢迎 ${user.name}` : ""}！现在可以开始对话了。`);
      return;
    }

    await send("你好！你还没有绑定账号。请向管理员索取邀请码，然后直接回复邀请码即可开始使用。");
  };
}
