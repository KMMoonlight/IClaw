import { describe, expect, it } from "vitest";

import { generateId, randomToken } from "./random.js";

describe("generateId", () => {
  it("uses the readable prefix and is unique", () => {
    const a = generateId("iclaw");
    const b = generateId("iclaw");
    expect(a.startsWith("iclaw-")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("randomToken", () => {
  it("produces hex of the requested byte length", () => {
    expect(randomToken(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomToken(4)).toMatch(/^[0-9a-f]{8}$/);
  });
});
