import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

import { resetConfigCache } from "../config.js";
import {
  getSkill,
  installSkillFromGithub,
  loadSkills,
  parseGithubRepo,
  resetSkillsCache,
  skillsPrompt,
} from "./skills.js";

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
  // Clean any dirs created by the github-install tests.
  fs.rmSync(path.join(skillsDir, "repo-fake"), { recursive: true, force: true });
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

  it("parses declared allowed-tools and requires", () => {
    writeSkill(
      "with-deps",
      "---\nname: with-deps\ndescription: d\nallowed-tools: bash, read_file\nrequires: [git, node]\n---\nbody",
    );
    const skill = getSkill("with-deps")!;
    expect(skill.allowedTools).toEqual(["bash", "read_file"]);
    expect(skill.requires).toEqual(["git", "node"]);
    expect(skillsPrompt()).toContain("需要工具：bash, read_file");
  });

  it("parses a version from frontmatter and shows it", () => {
    writeSkill("versioned", "---\nname: versioned\nversion: 1.2.0\ndescription: d\n---\nbody");
    expect(getSkill("versioned")?.version).toBe("1.2.0");
    expect(skillsPrompt()).toContain("- versioned v1.2.0: d");
  });

  it("omits disabled skills from the prompt listing", () => {
    writeSkill("visible", "---\nname: visible\ndescription: d\n---\nb");
    writeSkill("hidden", "---\nname: hidden\ndescription: d\n---\nb");
    const prompt = skillsPrompt(["hidden"]);
    expect(prompt).toContain("visible");
    expect(prompt).not.toContain("- hidden");
  });
});

describe("parseGithubRepo", () => {
  it("normalizes common GitHub repo input forms", () => {
    expect(parseGithubRepo("anthropics/skills")).toEqual({ owner: "anthropics", repo: "skills" });
    expect(parseGithubRepo("https://github.com/anthropics/skills")).toEqual({ owner: "anthropics", repo: "skills" });
    expect(parseGithubRepo("https://github.com/anthropics/skills.git")).toEqual({ owner: "anthropics", repo: "skills" });
    expect(parseGithubRepo("github.com/a/b/")).toEqual({ owner: "a", repo: "b" });
  });

  it("rejects invalid input", () => {
    expect(() => parseGithubRepo("")).toThrow();
    expect(() => parseGithubRepo("just-a-string")).toThrow();
    expect(() => parseGithubRepo("a/b/c")).toThrow();
    expect(() => parseGithubRepo("https://gitlab.com/a/b")).toThrow();
  });
});

describe("installSkillFromGithub", () => {
  /** Build a gzip tarball of a fake repo dir and mock global fetch to serve it. */
  async function mockRepoFetch(repoRoot: string): Promise<void> {
    const buf = await tar.c({ gzip: true, cwd: repoRoot }, ["repo-fake"]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(buf, { status: 200 })),
    );
  }

  it("installs a single-skill repo and discovers the skill", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-repo-"));
    const repoDir = path.join(repoRoot, "repo-fake");
    fs.mkdirSync(repoDir);
    fs.writeFileSync(
      path.join(repoDir, "SKILL.md"),
      "---\nname: github-skill\ndescription: from github\n---\nbody",
    );
    await mockRepoFetch(repoRoot);

    const result = await installSkillFromGithub("owner/repo-fake");
    expect(result.names).toContain("github-skill");
    expect(getSkill("github-skill")?.description).toBe("from github");
    expect(fs.existsSync(path.join(skillsDir, "repo-fake", "SKILL.md"))).toBe(true);

    vi.unstubAllGlobals();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("rejects a repo without any SKILL.md", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-repo-"));
    const repoDir = path.join(repoRoot, "repo-fake");
    fs.mkdirSync(repoDir);
    fs.writeFileSync(path.join(repoDir, "README.md"), "no skill here");
    await mockRepoFetch(repoRoot);

    await expect(installSkillFromGithub("owner/repo-fake")).rejects.toThrow("SKILL.md");
    expect(fs.existsSync(path.join(skillsDir, "repo-fake"))).toBe(false);

    vi.unstubAllGlobals();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("rejects when the target directory already exists", async () => {
    writeSkill("repo-fake", "---\nname: existing\n---\nbody");
    await expect(installSkillFromGithub("owner/repo-fake")).rejects.toThrow("已存在");
  });

  it("rejects failed downloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    await expect(installSkillFromGithub("owner/missing-repo")).rejects.toThrow("404");
    vi.unstubAllGlobals();
  });
});
