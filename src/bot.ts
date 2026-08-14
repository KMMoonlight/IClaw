import { runAgentTurn } from "./agent/runtime.js";
import { getBindingByAccount, getUser } from "./db/index.js";
import { logger } from "./logger.js";
import { resolveWeixinAccount } from "./wechat/accounts.js";
import { getContextToken } from "./wechat/context-token.js";
import type { InboundContext } from "./wechat/inbound.js";
import { sendTextMessage } from "./wechat/send.js";

/**
 * The bot's inbound handler. Each bot account is 1:1 bound to a user
 * (扫码即绑定), so routing is: accountId → user → per-user Pi agent.
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

    const binding = getBindingByAccount(ctx.accountId);
    if (!binding) {
      await send("此 Bot 账号尚未绑定用户，请联系管理员完成绑定。");
      return;
    }

    const user = getUser(binding.userId);
    if (!user || user.status !== "active") return; // frozen or missing → silent

    try {
      const reply = await runAgentTurn(user.id, ctx);
      if (reply) await send(reply);
    } catch (err) {
      // Log the detail internally; never leak raw errors to the user.
      logger.error(
        `bot: turn failed for user=${user.id} from=${ctx.from}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      await send("处理出错，请稍后再试。");
    }
  };
}
