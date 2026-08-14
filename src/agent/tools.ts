import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { appendUserMemory, getUser, setUserMemory } from "../db/index.js";
import { getSkill } from "./skills.js";

const RememberSchema = Type.Object({ fact: Type.String() });
type RememberParams = Static<typeof RememberSchema>;

const ForgetSchema = Type.Object({});

const ReadSkillSchema = Type.Object({ name: Type.String() });
type ReadSkillParams = Static<typeof ReadSkillSchema>;

/** `remember` — append a fact to the current user's memory. */
function rememberTool(userId: string): AgentTool<typeof RememberSchema> {
  return {
    name: "remember",
    label: "Remember",
    description: "记住关于当前用户的一条事实，供以后对话使用。",
    parameters: RememberSchema,
    execute: async (_id, params: RememberParams) => {
      appendUserMemory(userId, params.fact);
      return { content: [{ type: "text", text: `已记住：${params.fact}` }], details: {} };
    },
  };
}

/** `forget` — clear the current user's memory. */
function forgetTool(userId: string): AgentTool<typeof ForgetSchema> {
  return {
    name: "forget",
    label: "Forget",
    description: "清除关于当前用户的全部记忆。",
    parameters: ForgetSchema,
    execute: async () => {
      setUserMemory(userId, "");
      return { content: [{ type: "text", text: "已清除该用户的记忆。" }], details: {} };
    },
  };
}

/** `read_skill` — load a skill's full instructions on demand. */
function readSkillTool(): AgentTool<typeof ReadSkillSchema> {
  return {
    name: "read_skill",
    label: "Read skill",
    description: "按名称加载一个技能的完整说明（SKILL.md 内容）。",
    parameters: ReadSkillSchema,
    execute: async (_id, params: ReadSkillParams) => {
      const skill = getSkill(params.name);
      if (!skill) {
        return { content: [{ type: "text", text: `未找到技能：${params.name}` }], details: {} };
      }
      return { content: [{ type: "text", text: skill.body }], details: {} };
    },
  };
}

/**
 * Build the shared tool set for a user. Tools are identical across users
 * (same name/description/schema); the memory tools are bound to `userId` so
 * their side effects land in the right profile.
 */
export function buildTools(userId: string, extraTools: AgentTool<any>[] = []): AgentTool<any>[] {
  return [rememberTool(userId), forgetTool(userId), readSkillTool(), ...extraTools];
}

export function currentUserMemory(userId: string): string {
  return getUser(userId)?.memory ?? "";
}
