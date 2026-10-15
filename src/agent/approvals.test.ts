import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { openDbInMemory } from "../db/index.js";
import {
  PENDING_ACTION_TTL_MS,
  clearAllPendingActions,
  clearPendingAction,
  getPendingAction,
  parseApprovalReply,
  setPendingAction,
  withApproval,
} from "./approvals.js";

beforeEach(() => {
  clearAllPendingActions();
  openDbInMemory();
});

function fakeTool(execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "done" }], details: {} })): AgentTool<any> {
  return { name: "bash", label: "Bash", description: "d", parameters: {} as never, execute };
}

describe("pending action state", () => {
  it("sets, reads and clears per-user pending actions", () => {
    expect(getPendingAction("u1")).toBeNull();
    setPendingAction("u1", {
      userId: "u1",
      toolName: "bash",
      params: { command: "ls" },
      execute: vi.fn() as never,
      createdAt: Date.now(),
    });
    expect(getPendingAction("u1")?.toolName).toBe("bash");
    expect(getPendingAction("u2")).toBeNull();
    clearPendingAction("u1");
    expect(getPendingAction("u1")).toBeNull();
  });

  it("drops pending actions once they expire", () => {
    setPendingAction("u1", {
      userId: "u1",
      toolName: "bash",
      params: { command: "rm -rf /" },
      execute: vi.fn() as never,
      createdAt: Date.now() - PENDING_ACTION_TTL_MS - 1,
    });
    expect(getPendingAction("u1")).toBeNull();
    // Expired action is evicted, not just hidden.
    expect(getPendingAction("u1")).toBeNull();
  });
});

describe("parseApprovalReply", () => {
  it("recognises explicit approvals and rejections in zh/en", () => {
    for (const t of ["同意", "确认执行", "执行", "y", "YES", "approve"]) expect(parseApprovalReply(t)).toBe("approve");
    for (const t of ["拒绝", "取消", "no", "N", "reject"]) expect(parseApprovalReply(t)).toBe("reject");
    expect(parseApprovalReply("今天天气怎么样")).toBeNull();
    expect(parseApprovalReply("  ")).toBeNull();
  });

  it("does not treat casual acknowledgements as approval", () => {
    for (const t of ["好", "好的", "是", "可以", "ok", "okay", "嗯"]) {
      expect(parseApprovalReply(t), t).toBeNull();
    }
  });
});

describe("withApproval", () => {
  it("defers execution and records the action instead of running it", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ran" }], details: {} });
    const wrapped = withApproval("u1", fakeTool(execute));
    const result = await wrapped.execute("c1", { command: "rm -rf /" } as never);
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("需要用户确认");
    expect(execute).not.toHaveBeenCalled();

    const pending = getPendingAction("u1")!;
    expect(pending.toolName).toBe("bash");
    expect(pending.params).toEqual({ command: "rm -rf /" });

    // The user approves → the stored executor runs with the original params.
    await pending.execute("approval", pending.params as never);
    expect(execute).toHaveBeenCalledWith("approval", { command: "rm -rf /" });
  });
});
