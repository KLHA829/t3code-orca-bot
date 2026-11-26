import { describe, expect, it } from "@effect/vitest";

import { memoryForJob, parseMemoryEntries, trigramScore, trigramsOf } from "./botMemory.ts";

const memory = `# Helper memory

Durable facts the bot learns across jobs are appended here.

## 2026-01-01T09:00:00.000Z

The project deploys with vp run deploy, never npm run deploy.

## 2026-01-02T09:00:00.000Z

使用者偏好用廣東話溝通。

## 2026-01-03T09:00:00.000Z

The API token rotation runbook lives in docs/runbooks/tokens.md.
`;

describe("parseMemoryEntries", () => {
  it("parses timestamped sections and skips the preamble", () => {
    const entries = parseMemoryEntries(memory);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.heading).toBe("2026-01-01T09:00:00.000Z");
    expect(entries[0]?.text).toContain("vp run deploy");
    expect(entries[1]?.text).toContain("廣東話");
  });

  it("skips empty sections", () => {
    expect(parseMemoryEntries("## 2026-01-01\n\n## 2026-01-02\n\nkept\n")).toHaveLength(1);
  });
});

describe("trigramScore", () => {
  it("covers english substrings", () => {
    const query = trigramsOf("rotate the api token");
    const entry = trigramsOf("The API token rotation runbook lives in docs.");
    const unrelated = trigramsOf("Deploys use vp run deploy.");
    expect(trigramScore(query, entry)).toBeGreaterThan(0.3);
    expect(trigramScore(query, unrelated)).toBeLessThan(0.15);
  });

  it("covers CJK substrings", () => {
    const query = trigramsOf("用廣東話回覆");
    const entry = trigramsOf("使用者偏好用廣東話溝通。");
    expect(trigramScore(query, entry)).toBeGreaterThan(0.3);
  });
});

describe("memoryForJob", () => {
  it("picks relevant entries over irrelevant older ones", () => {
    const selected = memoryForJob(memory, "How do I rotate the API token?");
    expect(selected).toContain("tokens.md");
    expect(selected).not.toContain("vp run deploy");
  });

  it("always includes the most recent entries", () => {
    const selected = memoryForJob(memory, "rotate the api token", { alwaysRecent: 1 });
    expect(selected).toContain("tokens.md");
  });

  it("keeps relevant CJK memory for a CJK job", () => {
    const selected = memoryForJob(memory, "佢想我用廣東話講嘢");
    expect(selected).toContain("廣東話");
  });

  it("returns entries oldest first", () => {
    const selected = memoryForJob(memory, "deploy token");
    const deploy = selected.indexOf("vp run deploy");
    const token = selected.indexOf("tokens.md");
    expect(deploy).toBeGreaterThanOrEqual(0);
    expect(token).toBeGreaterThan(deploy);
  });

  it("falls back to the file tail when nothing parses as entries", () => {
    const prose = "x".repeat(200);
    expect(memoryForJob(prose, "anything", { maxChars: 50 })).toHaveLength(50);
  });

  it("caps the total characters", () => {
    const big = Array.from(
      { length: 20 },
      (_, index) =>
        `## 2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z\n\nshared topic ${"x".repeat(300)}`,
    ).join("\n\n");
    const selected = memoryForJob(big, "shared topic", { maxChars: 1_000, alwaysRecent: 2 });
    expect(selected.length).toBeLessThanOrEqual(1_000);
    expect(selected).toContain("shared topic");
  });
});
