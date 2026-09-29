import type { GitEngine, Side } from "../git/GitEngine";
import { Mutex } from "../util/mutex";
import { autoResolve, stageHandResolved } from "./ConflictHandler";

export type SyncState =
  | { kind: "idle"; lastSync?: number }
  | { kind: "syncing" }
  | { kind: "offline" }
  | { kind: "conflict"; files: string[] }
  | { kind: "error"; message: string };

const MAX_PUSH_RETRIES = 3;

/** Runs commit -> fetch -> merge -> push cycles, one at a time. */
export class SyncManager {
  private mutex = new Mutex();
  state: SyncState = { kind: "idle" };

  constructor(
    private engine: GitEngine,
    private deviceName: () => string,
    private onState: (s: SyncState) => void = () => {},
    private notify: (msg: string) => void = () => {},
  ) {}

  private set(s: SyncState) {
    this.state = s;
    this.onState(s);
  }

  private conflict(files: string[]): SyncState {
    this.set({ kind: "conflict", files });
    return this.state;
  }

  /** Full cycle: commit local work, integrate remote, push. */
  sync(): Promise<SyncState> {
    return this.mutex.run(async () => {
      this.set({ kind: "syncing" });
      try {
        // A previous merge left conflicts: pick up any the user fixed by hand, hold if some remain.
        if ((await this.engine.conflictedFiles()).length) {
          const still = await stageHandResolved(this.engine);
          if (still.length) return this.conflict(still);
        }
        // Conclude a merge whose conflicts are all resolved (no-op if none is in progress). Needed even
        // when the result equals HEAD, where a plain commit would see a clean tree and leave MERGE_HEAD behind.
        if (await this.engine.finishMerge()) this.notify("Conflicts resolved and merged.");

        // Always commit local work first so merges run against a clean tree.
        await this.engine.commitAll(`vault sync: ${this.deviceName() || "device"} ${new Date().toISOString()}`);

        for (let attempt = 0; attempt < MAX_PUSH_RETRIES; attempt++) {
          await this.engine.fetch();
          const merged = await this.engine.mergeRemote();
          if (merged.kind === "conflicts") {
            const { remaining, notes } = await autoResolve(this.engine);
            for (const n of notes) this.notify(n);
            if (remaining.length) return this.conflict(remaining);
            await this.engine.finishMerge();
          }
          const pushed = await this.engine.push();
          if (pushed.kind === "ok") {
            this.set({ kind: "idle", lastSync: Date.now() });
            return this.state;
          }
          await new Promise((r) => setTimeout(r, 200 + Math.random() * 800));
        }
        this.set({ kind: "error", message: "Push kept being rejected; will retry." });
      } catch (e) {
        this.set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
      return this.state;
    });
  }

  /** User chose a side for one conflicted file (from the conflict modal). Returns files still unresolved. */
  resolve(path: string, side: Side): Promise<string[]> {
    return this.mutex.run(async () => {
      await this.engine.takeSide(path, side);
      const left = await this.engine.conflictedFiles();
      this.set(left.length ? { kind: "conflict", files: left } : { kind: "idle", lastSync: this.lastSync() });
      return left;
    });
  }

  private lastSync(): number | undefined {
    return this.state.kind === "idle" ? this.state.lastSync : undefined;
  }

  currentConflicts(): string[] {
    return this.state.kind === "conflict" ? this.state.files : [];
  }
}
