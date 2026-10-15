import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export interface PendingAction {
  userId: string;
  toolName: string;
  params: Record<string, unknown>;
  /** The original (unwrapped) tool executor, invoked once the user approves. */
  execute: (id: string, params: never) => Promise<AgentToolResult<unknown>>;
  createdAt: number;
}

/** In-memory, per-user pending approvals (single-process; lost on restart). */
const pending = new Map<string, PendingAction>();

export function setPendingAction(userId: string, action: PendingAction): void {
  pending.set(userId, action);
}

/** A pending approval goes stale after this long and is silently discarded. */
export const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

/** Read a user's pending action, dropping it when it has expired. */
export function getPendingAction(userId: string): PendingAction | null {
  const action = pending.get(userId);
  if (!action) return null;
  if (Date.now() - action.createdAt > PENDING_ACTION_TTL_MS) {
    pending.delete(userId);
    return null;
  }
  return action;
}

export function clearPendingAction(userId: string): void {
  pending.delete(userId);
}

export function clearAllPendingActions(): void {
  pending.clear();
}

// Deliberately strict: only explicit, unambiguous confirmations. Casual replies
// like「好」「是」「ok」must NOT approve a dangerous action.
const APPROVE = new Set(["同意", "同意执行", "确认执行", "确认", "执行", "approve", "approved", "yes", "y"]);
const REJECT = new Set(["拒绝", "取消", "不要", "不要执行", "reject", "cancel", "no", "n"]);

/** Interpret a user reply as an approval decision (or null when unrelated). */
export function parseApprovalReply(text: string): "approve" | "reject" | null {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return null;
  if (APPROVE.has(trimmed)) return "approve";
  if (REJECT.has(trimmed)) return "reject";
  return null;
}

/**
 * Wrap a dangerous tool so its execution is deferred until the user confirms.
 * The wrapped call records the pending action and returns a placeholder result;
 * the bot then asks the user, and executes the stored action on approval.
 */
export function withApproval(userId: string, tool: AgentTool<any>): AgentTool<any> {
  return {
    ...tool,
    execute: async (_id, params) => {
      setPendingAction(userId, {
        userId,
        toolName: tool.name,
        params: (params ?? {}) as Record<string, unknown>,
        execute: tool.execute.bind(tool) as PendingAction["execute"],
        createdAt: Date.now(),
      });
      return {
        content: [{ type: "text", text: `操作「${tool.name}」需要用户确认，已挂起等待用户回复。` }],
        details: {},
      };
    },
  };
}
