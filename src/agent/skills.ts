import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../config.js";
import { logger } from "../logger.js";

export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
}

function parseSkillMd(content: string): { name: string; description: string; body: string } {
  const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) return { name: "", description: "", body: content };
  const fm = m[1] ?? "";
  const body = m[2] ?? "";
  const name = fm.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim() ?? "";
  const description = fm.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim() ?? "";
  return { name, description, body };
}

function findSkillsInDir(dir: string, out: Skill[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const skillMd = path.join(full, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        try {
          const parsed = parseSkillMd(fs.readFileSync(skillMd, "utf-8"));
          out.push({ name: parsed.name || entry.name, description: parsed.description, body: parsed.body, path: skillMd });
        } catch (err) {
          logger.warn(`skills: failed to read ${skillMd}: ${String(err)}`);
        }
      } else {
        findSkillsInDir(full, out);
      }
    }
  }
}

let cache: Skill[] | null = null;

export function loadSkills(): Skill[] {
  if (cache) return cache;
  cache = [];
  const dir = loadConfig().skillsDir;
  const abs = path.isAbsolute(dir) ? dir : path.resolve(dir);
  findSkillsInDir(abs, cache);
  return cache;
}

export function resetSkillsCache(): void {
  cache = null;
}

/** A compact list of skills (name + description) injected into the system prompt. */
export function skillsPrompt(): string {
  const skills = loadSkills();
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description || "(no description)"}`);
  return `## 可用技能（用 read_skill 工具按需加载完整说明）\n${lines.join("\n")}`;
}

export function getSkill(name: string): Skill | undefined {
  return loadSkills().find((s) => s.name === name);
}
