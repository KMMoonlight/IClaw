import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadGetUpdatesBuf, saveGetUpdatesBuf } from "./sync-buf.js";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-syncbuf-test-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("getUpdates sync buffer", () => {
  it("round-trips through the JSON file", () => {
    const file = path.join(dir, "acc.sync.json");
    saveGetUpdatesBuf(file, "buf-123");
    expect(loadGetUpdatesBuf(file)).toBe("buf-123");
    saveGetUpdatesBuf(file, "buf-456");
    expect(loadGetUpdatesBuf(file)).toBe("buf-456");
  });

  it("returns undefined for missing files", () => {
    expect(loadGetUpdatesBuf(path.join(dir, "missing.sync.json"))).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    const file = path.join(dir, "broken.sync.json");
    fs.writeFileSync(file, "{not json", "utf-8");
    expect(loadGetUpdatesBuf(file)).toBeUndefined();
  });
});
