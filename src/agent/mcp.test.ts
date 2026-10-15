import { describe, expect, it } from "vitest";

import {
  MCP_ENV_ALLOWLIST,
  SECRET_MASK,
  buildMcpEnv,
  maskArgSecrets,
  maskMcpServers,
  maskUrlSecrets,
  mergeMaskedSecrets,
} from "./mcp.js";

describe("buildMcpEnv", () => {
  it("forwards only allowlisted variables", () => {
    const env = buildMcpEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      LANG: "en_US.UTF-8",
      ICLAW_API_KEY: "secret",
      OPENAI_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.ICLAW_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("omits variables that are absent from the parent env", () => {
    const env = buildMcpEnv({ PATH: "/bin" });
    expect(env.HOME).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("merges per-server vars, overriding the allowlist", () => {
    const env = buildMcpEnv({ PATH: "/bin" }, { PATH: "/custom", GITHUB_TOKEN: "tok" });
    expect(env.PATH).toBe("/custom");
    expect(env.GITHUB_TOKEN).toBe("tok");
  });

  it("never includes a key that is not in the allowlist", () => {
    for (const key of MCP_ENV_ALLOWLIST) {
      expect(key.startsWith("ICLAW_")).toBe(false);
    }
  });
});

describe("MCP secret masking", () => {
  const servers = { gh: { command: "npx", env: { GITHUB_TOKEN: "ghp_secret", PLAIN: "x" } } };

  it("masks env values without mutating the input", () => {
    const masked = maskMcpServers(servers);
    expect(masked.gh!.env).toEqual({ GITHUB_TOKEN: SECRET_MASK, PLAIN: SECRET_MASK });
    expect(servers.gh!.env!.GITHUB_TOKEN).toBe("ghp_secret");
  });

  it("restores masked secrets from the stored config on save", () => {
    const merged = mergeMaskedSecrets(
      { gh: { command: "npx", env: { GITHUB_TOKEN: SECRET_MASK, NEW: "n" } } },
      servers,
    );
    expect(merged.gh!.env).toEqual({ GITHUB_TOKEN: "ghp_secret", NEW: "n" });
  });

  it("drops masked secrets that have no stored value", () => {
    const merged = mergeMaskedSecrets({ gh: { command: "npx", env: { GHOST: SECRET_MASK } } }, servers);
    expect(merged.gh!.env).toEqual({});
  });

  it("masks credentials in URL userinfo and in command args", () => {
    const withSecrets = {
      api: {
        url: "https://alice:sup3rsecret@mcp.example.com/sse",
        args: ["--token=abc123", "--api-key=xyz", "--monkey=banana", "--plain=keep", "--port", "8080"],
      },
    };
    const masked = maskMcpServers(withSecrets);
    expect(masked.api!.url).toBe(`https://${SECRET_MASK}@mcp.example.com/sse`);
    expect(masked.api!.args).toEqual([
      `--token=${SECRET_MASK}`,
      `--api-key=${SECRET_MASK}`,
      "--monkey=banana", // not a secret flag — must be left intact
      "--plain=keep",
      "--port",
      "8080",
    ]);
    // Non-secret args/userinfo are untouched and the input is not mutated.
    expect(withSecrets.api.url).toContain("sup3rsecret");
  });

  it("leaves URL userinfo-like text outside the authority alone", () => {
    expect(maskUrlSecrets("https://host/path@x")).toBe("https://host/path@x");
    expect(maskUrlSecrets("https://host?q=a@b")).toBe("https://host?q=a@b");
    expect(maskUrlSecrets("https://user:pass@host")).toBe(`https://${SECRET_MASK}@host`);
  });

  it("restores masked URL/args secrets on save", () => {
    const existing = { api: { url: "https://alice:sup3rsecret@mcp.example.com/sse", args: ["--token=abc123"] } };
    const merged = mergeMaskedSecrets(
      { api: { url: maskUrlSecrets(existing.api.url), args: [maskArgSecrets(existing.api.args[0]!)] } },
      existing,
    );
    expect(merged.api!.url).toBe(existing.api.url);
    expect(merged.api!.args).toEqual(["--token=abc123"]);
  });
});
