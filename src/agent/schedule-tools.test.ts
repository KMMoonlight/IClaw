import { beforeEach, describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { createUser, openDbInMemory } from "../db/index.js";
import { createScheduledTask, listScheduledTasks, parseTaskPayload } from "../scheduler/tasks.js";
import { MAX_TASKS_PER_USER, buildScheduleTools } from "./schedule-tools.js";

beforeEach(() => {
  openDbInMemory();
});

function tool(name: string, userId: string): AgentTool<any> {
  const found = buildScheduleTools(userId).find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

async function run(name: string, params: Record<string, unknown>, userId: string): Promise<string> {
  const result = await tool(name, userId).execute("call-1", params as never);
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text ?? "";
}

describe("buildScheduleTools", () => {
  it("registers the three scheduler tools", () => {
    expect(buildScheduleTools("u").map((t) => t.name)).toEqual(["schedule_task", "list_tasks", "cancel_task"]);
  });
});

describe("schedule_task", () => {
  it("schedules a one-off relative reminder", async () => {
    const u = createUser("u");
    const before = Date.now();
    const text = await run("schedule_task", { when: "+10m", prompt: "喝水" }, u.id);
    expect(text).toContain("已安排");
    const tasks = listScheduledTasks(u.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.kind).toBe("once");
    expect(tasks[0]!.prompt).toBe("喝水");
    expect(tasks[0]!.nextRunAt).toBeGreaterThanOrEqual(before + 600_000 - 2000);
    expect(tasks[0]!.nextRunAt).toBeLessThanOrEqual(Date.now() + 600_000 + 2000);
  });

  it("schedules a recurring cron task", async () => {
    const u = createUser("u");
    await run("schedule_task", { when: "0 9 * * *", prompt: "早报" }, u.id);
    const tasks = listScheduledTasks(u.id);
    expect(tasks[0]!.kind).toBe("cron");
    expect(tasks[0]!.spec).toBe("0 9 * * *");
  });

  it("stores agent mode in the task payload", async () => {
    const u = createUser("u");
    await run("schedule_task", { when: "0 8 * * *", prompt: "生成早报", mode: "agent" }, u.id);
    expect(parseTaskPayload(listScheduledTasks(u.id)[0]!.payload).mode).toBe("agent");
  });

  it("rejects an empty prompt or unparseable time", async () => {
    const u = createUser("u");
    expect(await run("schedule_task", { when: "+1m", prompt: "  " }, u.id)).toContain("不能为空");
    expect(await run("schedule_task", { when: "someday", prompt: "x" }, u.id)).toContain("无法解析时间");
    expect(listScheduledTasks(u.id)).toHaveLength(0);
  });

  it("enforces the per-user task cap", async () => {
    const u = createUser("u");
    for (let i = 0; i < MAX_TASKS_PER_USER; i++) {
      createScheduledTask({ userId: u.id, kind: "cron", spec: "0 9 * * *", prompt: `t${i}` });
    }
    expect(await run("schedule_task", { when: "+1m", prompt: "one too many" }, u.id)).toContain("最多");
  });
});

describe("list_tasks", () => {
  it("reports none and then lists active tasks", async () => {
    const u = createUser("u");
    expect(await run("list_tasks", {}, u.id)).toContain("暂无");
    const text = await run("schedule_task", { when: "+5m", prompt: "开会" }, u.id);
    expect(text).toContain("已安排");
    expect(await run("list_tasks", {}, u.id)).toContain("开会");
  });
});

describe("cancel_task", () => {
  it("cancels an owned task and refuses unknown/foreign ids", async () => {
    const u = createUser("u");
    const other = createUser("other");
    await run("schedule_task", { when: "+5m", prompt: "开会" }, u.id);
    const task = listScheduledTasks(u.id)[0]!;

    expect(await run("cancel_task", { id: task.id }, other.id)).toContain("未找到");
    expect(listScheduledTasks(u.id)).toHaveLength(1);

    expect(await run("cancel_task", { id: task.id }, u.id)).toContain("已取消");
    expect(listScheduledTasks(u.id)).toHaveLength(0);
    expect(await run("cancel_task", { id: "nope" }, u.id)).toContain("未找到");
  });
});
