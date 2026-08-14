import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

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

// ---------------------------------------------------------------------------
// Install from a GitHub repo（无需 git 二进制：下载 codeload tarball 解压）
// ---------------------------------------------------------------------------

const GITHUB_TARBALL_MAX_BYTES = 20 * 1024 * 1024;
const GITHUB_TARBALL_TIMEOUT_MS = 60_000;
const MAX_EXTRACTED_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 10 * 1024 * 1024;

/** Normalize user input ("owner/repo", "github.com/o/r", "https://github.com/o/r[.git]") to {owner, repo}. */
export function parseGithubRepo(input: string): { owner: string; repo: string } {
  let raw = input.trim();
  if (!raw) throw new Error("请输入 GitHub 仓库地址（owner/repo 或完整 URL）");
  raw = raw.replace(/^https?:\/\//i, "").replace(/\.git$/i, "");
  raw = raw.replace(/^github\.com\//i, "");
  raw = raw.replace(/^\/+|\/+$/g, "");
  const parts = raw.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`无法识别的 GitHub 仓库：${input.trim()}（示例：anthropics/skills 或 https://github.com/anthropics/skills）`);
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

function extractRepoName(repo: string): string {
  return repo.replace(/[^\w.-]/g, "-");
}

/** Download the repo tarball to a temp file (bounded by size and time). */
async function downloadGithubTarball(owner: string, repo: string, destPath: string): Promise<void> {
  const url = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/HEAD`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TARBALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) {
      throw new Error(`下载仓库失败：HTTP ${res.status}（确认仓库是公开的且地址正确）`);
    }
    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > GITHUB_TARBALL_MAX_BYTES) {
      throw new Error(`仓库压缩包超过 ${GITHUB_TARBALL_MAX_BYTES / 1024 / 1024}MB 上限`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("下载仓库失败：无法读取响应体");
    const out = fs.createWriteStream(destPath);
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > GITHUB_TARBALL_MAX_BYTES) {
        throw new Error(`仓库压缩包超过 ${GITHUB_TARBALL_MAX_BYTES / 1024 / 1024}MB 上限`);
      }
      out.write(value);
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Install a public GitHub repo as a skill directory.
 * The repo may be a single skill (SKILL.md at root) or a collection of skills.
 * Returns the list of skill names discovered under the installed directory.
 */
export async function installSkillFromGithub(input: string): Promise<{ names: string[] }> {
  const { owner, repo } = parseGithubRepo(input);
  const skillsRoot = loadConfig().skillsDir;
  const absRoot = path.isAbsolute(skillsRoot) ? skillsRoot : path.resolve(skillsRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const targetDir = path.join(absRoot, extractRepoName(repo));
  if (fs.existsSync(targetDir)) {
    throw new Error(`技能目录已存在：${extractRepoName(repo)}（请先删除同名技能）`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-skill-"));
  const tarball = path.join(tmp, "repo.tar.gz");
  const extractDir = path.join(tmp, "extract");
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await downloadGithubTarball(owner, repo, tarball);

    let entries = 0;
    await tar.x({
      file: tarball,
      cwd: extractDir,
      strip: 1, // drop the top-level "<repo>-<sha>/" directory
      filter: (entryPath, entry) => {
        entries += 1;
        if (entries > MAX_EXTRACTED_ENTRIES) return false;
        if (entryPath.includes("..") || entryPath.startsWith("/")) return false; // traversal guard
        if ("type" in entry && entry.type === "File" && (entry.size ?? 0) > MAX_ENTRY_BYTES) return false;
        return true;
      },
    });

    // Verify the repo actually contains a skill before installing.
    let hasSkill = false;
    const check = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !hasSkill) check(path.join(dir, e.name));
        else if (e.isFile() && e.name.toUpperCase() === "SKILL.MD") hasSkill = true;
      }
    };
    check(extractDir);
    if (!hasSkill) {
      throw new Error("仓库中未找到 SKILL.md（skills 仓库需要每个技能目录含 SKILL.md）");
    }

    fs.cpSync(extractDir, targetDir, { recursive: true });
    resetSkillsCache();
    const installed = loadSkills().filter((s) => s.path.startsWith(targetDir + path.sep));
    logger.info(`skills: installed github.com/${owner}/${repo} -> ${targetDir} (${installed.length} skill(s))`);
    return { names: installed.map((s) => s.name) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
