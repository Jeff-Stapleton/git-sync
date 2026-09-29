import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncScheduler } from "../src/sync/SyncScheduler";
import type { SyncState } from "../src/sync/SyncManager";

const idle: SyncState = { kind: "idle", lastSync: 1 };

function make(overrides: Partial<ConstructorParameters<typeof SyncScheduler>[0]> = {}) {
  const runSync = vi.fn(async (): Promise<SyncState> => idle);
  const s = new SyncScheduler({
    runSync, debounceMs: () => 5000, pullIntervalMs: () => 30000, isOnline: () => true, ...overrides,
  });
  return { s, runSync };
}

describe("SyncScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("syncs on start, then on each pull interval", async () => {
    const { s, runSync } = make();
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runSync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(runSync).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it("debounces edits into one sync", async () => {
    const { s, runSync } = make({ pullIntervalMs: () => 10 * 60_000 });
    s.start(); await vi.advanceTimersByTimeAsync(0);
    runSync.mockClear();
    s.noteChange(); await vi.advanceTimersByTimeAsync(3000); s.noteChange();
    await vi.advanceTimersByTimeAsync(4999);
    expect(runSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runSync).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it("skips the pull tick while an edit is pending", async () => {
    const { s, runSync } = make({ pullIntervalMs: () => 4000, debounceMs: () => 60_000 });
    s.start(); await vi.advanceTimersByTimeAsync(0);
    runSync.mockClear();
    s.noteChange(); await vi.advanceTimersByTimeAsync(12000);
    expect(runSync).not.toHaveBeenCalled();
    s.stop();
  });

  it("coalesces requests made during a sync into one follow-up", async () => {
    let release!: () => void;
    const runSync = vi.fn(() => new Promise<SyncState>((r) => (release = () => r(idle))));
    const { s } = make({ runSync });
    const p = s.requestSync.bind(s);
    s.start(); await vi.advanceTimersByTimeAsync(0);
    void p(); void p(); void p();
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(runSync).toHaveBeenCalledTimes(2);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(runSync).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it("retries with backoff after an error", async () => {
    const runSync = vi.fn<() => Promise<SyncState>>()
      .mockResolvedValueOnce({ kind: "error", message: "boom" })
      .mockResolvedValue(idle);
    const { s } = make({ runSync, pullIntervalMs: () => 10 * 60_000 });
    s.start(); await vi.advanceTimersByTimeAsync(0);
    expect(runSync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); // first backoff <= 5s
    expect(runSync).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it("does not sync while offline and reports it", async () => {
    const onOffline = vi.fn();
    const { s, runSync } = make({ isOnline: () => false, onOffline });
    s.start(); await vi.advanceTimersByTimeAsync(0);
    expect(runSync).not.toHaveBeenCalled();
    expect(onOffline).toHaveBeenCalled();
    s.stop();
  });
});
