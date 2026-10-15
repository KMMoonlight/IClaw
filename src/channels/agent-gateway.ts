import { clearPendingAction, getPendingAction, parseApprovalReply } from "../agent/approvals.js";
import { checkQuota, noteInboundMessage } from "../agent/quota.js";
import { dropAgent, resetUserSession, runAgentTurn, runUserExclusive } from "../agent/runtime.js";
import { loadConfig } from "../config.js";
import { getActiveSessionId, getUser, listSessions, switchActiveSession } from "../db/index.js";
import { logger } from "../logger.js";
import { inc } from "../metrics.js";
import type { InboundContext } from "../wechat/inbound.js";
import { ProgressiveSender } from "../wechat/progressive.js";
import type { InboundMessage, MessageHandler, ReplySink } from "./types.js";

const NEW_SESSION_COMMANDS = new Set(["/new", "/新会话"]);

function toolResultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();
  return text || "(无输出)";
}

export interface AgentGatewayOptions {
  /**
   * Resolve the IClaw user for an inbound message (channel/account specific).
   * Returning null means the account is not bound.
   */
  resolveUserId: (message: InboundMessage) => string | null;
  /** Called when no user is bound to the account. */
  onUnbound?: (message: InboundMessage, reply: ReplySink) => Promise<void>;
}

/**
 * Transport-agnostic message pipeline: routing → session commands → approvals →
 * quota → agent turn. Channels only provide a {@link ReplySink}; adding a new
 * channel never touches this logic or the agent core.
 */
export function createAgentGateway(options: AgentGatewayOptions): MessageHandler {
  return async (message, reply) => {
    const send = reply.text;

    const userId = options.resolveUserId(message);
    if (!userId) {
      if (options.onUnbound) await options.onUnbound(message, reply);
      return;
    }

    const user = getUser(userId);
    if (!user || user.status !== "active") return; // frozen or missing → silent
    inc("iclaw_messages_in_total");

    const body = message.text.trim();

    // --- session commands --------------------------------------------------
    if (NEW_SESSION_COMMANDS.has(body)) {
      resetUserSession(user.id);
      logger.info(`gateway: new session for user=${user.id}`);
      await send("✅ 已开启新会话（之前的会话历史已保留）。");
      return;
    }

    if (body === "/sessions" || body === "/会话列表") {
      const sessions = listSessions(user.id);
      const active = getActiveSessionId(user.id);
      if (sessions.length === 0) {
        await send("暂无会话。");
        return;
      }
      const lines = sessions.map(
        (s, i) => `${i + 1}. ${s.title || s.id.slice(0, 8)}（${s.messageCount} 条）${s.id === active ? " ← 当前" : ""}`,
      );
      await send(`会话列表：\n${lines.join("\n")}\n\n发送 /switch <序号> 切换。`);
      return;
    }
    if (body.startsWith("/switch ") || body.startsWith("/切换 ")) {
      const arg = body.split(/\s+/)[1] ?? "";
      const sessions = listSessions(user.id);
      const index = Number(arg) - 1;
      const target = Number.isInteger(index) && index >= 0 ? sessions[index] : undefined;
      if (!target) {
        await send("用法：/switch <序号>（先用 /sessions 查看）。");
        return;
      }
      if (switchActiveSession(user.id, target.id)) {
        dropAgent(user.id);
        await send(`✅ 已切换到会话 ${index + 1}。`);
      } else {
        await send("切换失败。");
      }
      return;
    }

    // --- dangerous-tool approval reply ------------------------------------
    const pendingAction = getPendingAction(user.id);
    if (pendingAction) {
      const decision = parseApprovalReply(body);
      if (decision === "approve") {
        clearPendingAction(user.id);
        try {
          // Serialize with the user's turn chain so it can't race an agent turn.
          const result = await runUserExclusive(user.id, () =>
            pendingAction.execute("approval", pendingAction.params as never),
          );
          await send(`✅ 已执行「${pendingAction.toolName}」：\n${toolResultText(result)}`);
        } catch (err) {
          logger.error(`gateway: approved action failed for user=${user.id}: ${String(err)}`);
          await send("执行失败，请稍后再试。");
        }
        return;
      }
      if (decision === "reject") {
        clearPendingAction(user.id);
        await send("已取消该操作。");
        return;
      }
      clearPendingAction(user.id);
    }

    // --- quota / rate limit ------------------------------------------------
    const quota = checkQuota(user.id);
    if (!quota.allowed) {
      await send(quota.reason ?? "已达到使用上限，请稍后再试。");
      return;
    }
    noteInboundMessage(user.id);

    // --- typing + agent turn ----------------------------------------------
    await reply.startTyping?.();
    try {
      const limit = loadConfig().sendChunkChars;
      const progressive = loadConfig().streamProgress ? new ProgressiveSender((t) => send(t), limit) : null;
      const ctx: InboundContext = {
        body: message.text,
        from: message.senderId,
        accountId: message.accountId,
        media: message.media,
        contextToken: message.contextToken,
      };
      const text = await runAgentTurn(
        user.id,
        ctx,
        progressive
          ? { onTextDelta: (delta) => progressive.push(delta), onRetry: () => progressive.reset() }
          : undefined,
      );
      if (progressive) await progressive.finish(text);
      else if (text) await send(text);
      const approval = getPendingAction(user.id);
      if (approval) {
        await send(`⚠️ 需要你确认执行「${approval.toolName}」，请回复「同意」或「拒绝」。`);
      }
    } catch (err) {
      logger.error(
        `gateway: turn failed for user=${user.id} channel=${message.channelId} from=${message.senderId}: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`,
      );
      await send("处理出错，请稍后再试。");
    } finally {
      await reply.stopTyping?.();
    }
  };
}
