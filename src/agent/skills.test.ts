import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetConfigCache } from "../config.js";
import { getSkill, loadSkills, resetSkillsCache, skillsPrompt } from "./skills.js";

let skillsDir: string;
const origSkillsDir = process.env.ICLAW_SKILLS_DIR;

function writeSkill(relDir: string, content: string): void {
  const dir = path.join(skillsDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf-8");
}

beforeAll(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-skills-test-"));
  process.env.ICLAW_SKILLS_DIR = skillsDir;
  resetConfigCache();
});

afterEach(() => {
  resetSkillsCache();
});

afterAll(() => {
  if (origSkillsDir === undefined) delete process.env.ICLAW_SKILLS_DIR;
  else process.env.ICLAW_SKILLS_DIR = origSkillsDir;
  resetConfigCache();
  resetSkillsCache();
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

describe("loadSkills", () => {
  it("returns an empty list when the skills dir is missing", () => {
    process.env.ICLAW_SKILLS_DIR = path.join(skillsDir, "nope");
    resetConfigCache();
    expect(loadSkills()).toEqual([]);
    process.env.ICLAW_SKILLS_DIR = skillsDir;
    resetConfigCache();
  });

  it("parses frontmatter name/description and body", () => {
    writeSkill(
      "my-skill",
      "---\nname: My Skill\ndescription: does things\n---\n\n# 正文\n步骤一",
    );
    const skills = loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("My Skill");
    expect(skills[0]?.description).toBe("does things");
    expect(skills[0]?.body).toContain("# 正文");
  });

  it("falls back to the directory name without frontmatter", () => {
    writeSkill("fallback", "# 无 frontmatter");
    const skill = loadSkills().find((s) => s.name === "fallback");
    expect(skill?.description).toBe("");
    expect(skill?.body).toContain("无 frontmatter");
  });

  it("discovers nested directories and supports lookup", () => {
    writeSkill("a/b/deep-skill", "---\nname: deep\ndescription: nested\n---\nbody");
    expect(getSkill("deep")?.description).toBe("nested");
    expect(getSkill("missing")).toBeUndefined();
  });

  it("builds the system-prompt skill listing", () => {
    writeSkill("listed", "---\nname: listed\ndescription: for the prompt\n---\nbody");
    expect(skillsPrompt()).toContain("- listed: for the prompt");
    expect(skillsPrompt()).toContain("read_skill");
  });
});
