import { describe, expect, it } from "vitest";
import { friendlyError, redact } from "../src/util/errors";
import { isTrivialVault } from "../src/util/firstSync";
import { SyncLog } from "../src/util/log";

describe("friendlyError", () => {
  const cases: [string, unknown, RegExp][] = [
    ["iso 401", Object.assign(new Error("HTTP Error: 401 Unauthorized"), { data: { statusCode: 401 } }), /Authentication failed/],
    ["cli auth", new Error("git fetch failed (128): fatal: Authentication failed for 'https://x'"), /Authentication failed/],
    ["cli no creds", new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), /Authentication failed/],
    ["iso 404", Object.assign(new Error("HTTP Error: 404 Not Found"), { data: { statusCode: 404 } }), /Repository not found/],
    ["cli 404", new Error("remote: Repository not found.\nfatal: repository 'https://x' not found"), /Repository not found/],
    ["dns", new Error("getaddrinfo ENOTFOUND github.com"), /Can't reach/],
    ["mobile fetch", new Error("Failed to fetch"), /Can't reach/],
    ["big file", new Error("remote: error: File big.bin is 120 MB; this exceeds GitHub's file size limit of 100 MB"), /too large/],
  ];
  it.each(cases)("%s", (_n, err, re) => expect(friendlyError(err)).toMatch(re));

  it("falls back to the raw message, truncated", () => {
    expect(friendlyError(new Error("x".repeat(500))).length).toBe(300);
    expect(friendlyError("plain string")).toBe("plain string");
  });
  it("never leaks the token", () => {
    expect(friendlyError(new Error("weird failure for ghp_SECRET123 here"), "ghp_SECRET123")).toBe("weird failure for *** here");
    expect(redact("abc", "")).toBe("abc"); // empty token is not a wildcard
  });
});

describe("isTrivialVault", () => {
  it("is trivial with only gitignore and obsidian config", () => {
    expect(isTrivialVault([])).toBe(true);
    expect(isTrivialVault([".gitignore", ".obsidian/app.json", ".obsidian/plugins/x/main.js"])).toBe(true);
  });
  it("is not trivial once a real note exists", () => {
    expect(isTrivialVault([".gitignore", "Daily/2026-09-28.md"])).toBe(false);
  });
});

describe("SyncLog", () => {
  it("keeps only the newest entries and redacts the token", () => {
    const log = new SyncLog(3, () => "tok-12345");
    for (let i = 0; i < 5; i++) log.info(`line ${i} tok-12345`);
    expect(log.all.map((e) => e.msg)).toEqual(["line 2 ***", "line 3 ***", "line 4 ***"]);
    expect(log.format()).toMatch(/INFO\s+line 4 \*\*\*/);
  });
});
