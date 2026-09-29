import { backoffDelay } from "../util/backoff";
import { Debouncer } from "../util/debounce";
import type { SyncState } from "./SyncManager";

const MAX_WAIT_MS = 30_000;

export interface SchedulerDeps {
  runSync: () => Promise<SyncState>;
  debounceMs: () => number;
  pullIntervalMs: () => number;
  isOnline: () => boolean;
  onOffline?: () => void;
}

/**
 * Decides *when* to sync: debounced after edits, on a pull interval, and on
 * demand (startup, focus, reconnect). Never runs two syncs at once; a request
 * that arrives mid-sync schedules exactly one follow-up run.
 */
export class SyncScheduler {
  private debouncer: Debouncer;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private rerun = false;
  private failures = 0;
  private stopped = true;
  private lastRunEnd = 0;

  constructor(private deps: SchedulerDeps) {
    this.debouncer = new Debouncer(() => void this.requestSync(), deps.debounceMs(), MAX_WAIT_MS);
  }

  start() {
    this.stopped = false;
    void this.requestSync();
    this.scheduleTick();
  }

  stop() {
    this.stopped = true;
    this.debouncer.cancel();
    clearTimeout(this.tickTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** A vault file changed; sync after the quiet period. */
  noteChange() {
    if (this.stopped) return;
    this.debouncer.setDelay(this.deps.debounceMs());
    this.debouncer.trigger();
  }

  /** Sync as soon as possible (startup, focus, reconnect, manual). */
  async requestSync(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    if (!this.deps.isOnline()) {
      this.deps.onOffline?.();
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        this.debouncer.cancel(); // this run will pick up whatever is pending
        const result = await this.deps.runSync();
        this.handleResult(result);
      } while (this.rerun && !this.stopped);
    } finally {
      this.running = false;
      this.lastRunEnd = Date.now();
    }
  }

  /** For noisy triggers like window focus: skip if we synced very recently. */
  requestSyncIfStale(minAgeMs: number): Promise<void> {
    if (Date.now() - this.lastRunEnd < minAgeMs) return Promise.resolve();
    return this.requestSync();
  }

  private handleResult(result: SyncState) {
    if (result.kind === "error") {
      this.failures++;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.requestSync();
      }, backoffDelay(this.failures - 1));
    } else if (result.kind === "idle") {
      this.failures = 0;
    }
  }

  private scheduleTick() {
    if (this.stopped) return;
    this.tickTimer = setTimeout(() => {
      // A pending edit or a backoff retry will sync on its own schedule.
      if (!this.debouncer.pending && this.retryTimer === undefined) void this.requestSync();
      this.scheduleTick();
    }, this.deps.pullIntervalMs());
  }
}
