import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelay } from "../src/util/backoff";
import { Debouncer } from "../src/util/debounce";
import { isIgnoredPath, mergeGitignore } from "../src/util/ignore";

describe("Debouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once after the quiet period", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, 5000, 30000);
    d.trigger(); vi.advanceTimersByTime(3000); d.trigger(); vi.advanceTimersByTime(4999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.pending).toBe(false);
  });

  it("fires at max-wait during continuous typing", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, 5000, 30000);
    for (let t = 0; t < 30000; t += 1000) { d.trigger(); vi.advanceTimersByTime(1000); }
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents firing", () => {
    const fn = vi.fn();
    const d = new Debouncer(fn, 1000, 5000);
    d.trigger(); d.cancel(); vi.advanceTimersByTime(10000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("backoffDelay", () => {
  it("grows and caps", () => {
    expect(backoffDelay(0, 5000, 300000, () => 0)).toBe(2500);
    expect(backoffDelay(3, 5000, 300000, () => 1)).toBe(40000);
    expect(backoffDelay(20, 5000, 300000, () => 1)).toBe(300000);
  });
});

describe("ignore", () => {
  it("never syncs the token file or workspace state", () => {
    expect(isIgnoredPath(".obsidian/plugins/git-sync/data.json")).toBe(true);
    expect(isIgnoredPath(".obsidian/workspace.json")).toBe(true);
    expect(isIgnoredPath(".git/index")).toBe(true);
    expect(isIgnoredPath("notes/a.md")).toBe(false);
    expect(isIgnoredPath(".obsidian/appearance.json")).toBe(false);
  });
  it("appends only missing gitignore lines", () => {
    const out = mergeGitignore("foo\n.DS_Store")!;
    expect(out).toContain("foo\n.DS_Store\n.obsidian/workspace.json");
    expect(out.match(/\.DS_Store/g)).toHaveLength(1);
    expect(mergeGitignore(out)).toBeNull();
  });
});
