import { GitEngine, MergeResult } from "../git/GitEngine";
import { Mutex } from "../util/mutex";

export type SyncState =
  | { kind: "idle"; lastSync?: number }
  | { kind: "syncing" }
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
  ) {}

  private set(s: SyncState) {
    this.state = s;
    this.onState(s);
  }

  /** Full cycle: commit local work, integrate remote, push. */
  sync(): Promise<SyncState> {
    return this.mutex.run(async () => {
      this.set({ kind: "syncing" });
      try {
        // A previous merge left conflicts: hold everything until they are resolved.
        const pending = await this.engine.conflictedFiles();
        if (pending.length) {
          this.set({ kind: "conflict", files: pending });
          return this.state;
        }

        // Always commit local work first so merges run against a clean tree.
        await this.engine.commitAll(`vault sync: ${this.deviceName() || "device"} ${new Date().toISOString()}`);

        for (let attempt = 0; attempt < MAX_PUSH_RETRIES; attempt++) {
          await this.engine.fetch();
          const merged: MergeResult = await this.engine.mergeRemote();
          if (merged.kind === "conflicts") {
            this.set({ kind: "conflict", files: merged.files });
            return this.state;
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
}
