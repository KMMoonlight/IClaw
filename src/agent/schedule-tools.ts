import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";

import {
  countActiveScheduledTasks,
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  parseTaskPayload,
  resolveScheduleSpec,
} from "../scheduler/tasks.js";
import type { ScheduledTask } from "../scheduler/tasks.js";

/** Guard against runaway task creation per user. */
export const MAX_TASKS_PER_USER = 20;

const ScheduleSchema = Type.Object({
  when: Type.String(),
  prompt: Type.String(),
  mode: Type.Optional(Type.String()),
});
type ScheduleParams = Static<typeof ScheduleSchema>;

const ListSchema = Type.Object({});
const CancelSchema = Type.Object({ id: Type.String() });
type CancelParams = Static<typeof CancelSchema>;

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

export function formatTask(task: ScheduledTask): string {
  const repeat = task.kind === "cron" ? `（重复：${task.spec}）` : "";
  const mode = parseTaskPayload(task.payload).mode === "agent" ? "[agent]" : "";
  return `- [${task.id}] ${formatTimestamp(task.nextRunAt)} ${mode}${task.prompt}${repeat}`;
}

/** `schedule_task` — create a one-off reminder or a recurring cron task. */
function scheduleTaskTool(userId: string): AgentTool<typeof ScheduleSchema> {
  return {
    name: "schedule_task",
    label: "Schedule task",
    description:
      "为用户安排一个定时提醒/任务。when 支持：cron 表达式（5 段，如 `0 9 * * *` 表示每天 9:00）、相对时间（如 `+10m`/`+2h`/`+1d`）、ISO 时间（如 `2025-01-01T09:00:00`）或毫秒时间戳。prompt 是到点时要发给用户的内容；若 mode=agent，则到点时会把 prompt 当作指令跑一次对话并把结果发给用户（适合“每天生成摘要”这类）。",
    parameters: ScheduleSchema,
    execute: async (_id, params: ScheduleParams) => {
      const prompt = params.prompt.trim();
      if (!prompt) {
        return { content: [{ type: "text", text: "提醒内容不能为空。" }], details: { isError: true } };
      }
      if (countActiveScheduledTasks(userId) >= MAX_TASKS_PER_USER) {
        return {
          content: [{ type: "text", text: `最多只能同时有 ${MAX_TASKS_PER_USER} 个定时任务，请先取消一些。` }],
          details: { isError: true },
        };
      }
      let schedule: ReturnType<typeof resolveScheduleSpec>;
      try {
        schedule = resolveScheduleSpec(params.when);
      } catch (err) {
        return {
          content: [{ type: "text", text: `无法解析时间「${params.when}」：${err instanceof Error ? err.message : String(err)}` }],
          details: { isError: true },
        };
      }
      const payload = params.mode === "agent" ? JSON.stringify({ mode: "agent" }) : null;
      const task = createScheduledTask({ userId, ...schedule, prompt, payload });
      return {
        content: [{ type: "text", text: `已安排（${task.id}），下次执行：${formatTimestamp(task.nextRunAt)}` }],
        details: {},
      };
    },
  };
}

/** `list_tasks` — list the user's scheduled tasks. */
function listTasksTool(userId: string): AgentTool<typeof ListSchema> {
  return {
    name: "list_tasks",
    label: "List tasks",
    description: "列出当前用户的所有定时任务（含任务 id、下次执行时间与内容）。",
    parameters: ListSchema,
    execute: async () => {
      const tasks = listScheduledTasks(userId).filter((t) => t.status === "active");
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "（暂无定时任务）" }], details: {} };
      }
      return { content: [{ type: "text", text: tasks.map(formatTask).join("\n") }], details: {} };
    },
  };
}

/** `cancel_task` — cancel one of the user's tasks by id. */
function cancelTaskTool(userId: string): AgentTool<typeof CancelSchema> {
  return {
    name: "cancel_task",
    label: "Cancel task",
    description: "按 id 取消当前用户的某个定时任务。",
    parameters: CancelSchema,
    execute: async (_id, params: CancelParams) => {
      const task = getScheduledTask(params.id.trim());
      if (!task || task.userId !== userId) {
        return { content: [{ type: "text", text: `未找到任务：${params.id}` }], details: { isError: true } };
      }
      deleteScheduledTask(task.id);
      return { content: [{ type: "text", text: `已取消任务：${task.prompt}` }], details: {} };
    },
  };
}

/** Build the scheduler tool set bound to a user. */
export function buildScheduleTools(userId: string): AgentTool<any>[] {
  return [scheduleTaskTool(userId), listTasksTool(userId), cancelTaskTool(userId)];
}
