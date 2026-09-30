import type { GitEngine, Side } from "../git/GitEngine";
import { friendlyError } from "../util/errors";
import { isTrivialVault } from "../util/firstSync";
import type { SyncLog } from "../util/log";
import { Mutex } from "../util/mutex";
import { autoResolve, stageHandResolved } from "./ConflictHandler";

export type SyncState =
  | { kind: "idle"; lastSync?: number }
  | { kind: "syncing" }
  | { kind: "offline" }
  | { kind: "paused"; reason: string }
  | { kind: "conflict"; files: string[] }
  | { kind: "error"; message: string };

const MAX_PUSH_RETRIES = 3;
const MB = 1024 * 1024;
/** GitHub rejects pushes containing files over 100 MB, and would keep rejecting every later push. */
export const HOST_FILE_LIMIT_BYTES = 100 * MB;

export interface SyncExtras {
  log?: SyncLog;
  /** Asked once when this vault and the remote both hold notes but share no history. */
  confirmUnrelated?: () => Promise<boolean>;
  /** Warn about files at or above this size (bytes). Omit to disable the guard. */
  warnBytes?: number;
  /** Override the host limit at which files are kept out of sync (tests only). */
  excludeBytes?: number;
  token?: () => string;
}

/** Runs commit -> fetch -> merge -> push cycles, one at a time. */
export class SyncManager {
  private mutex = new Mutex();
  private unrelated: "ask" | "approved" | "declined" = "ask";
  private warned = new Set<string>();
  private excludedNotified = new Set<string>();
  state: SyncState = { kind: "idle" };

  constructor(
    private engine: GitEngine,
    private deviceName: () => string,
    private onState: (s: SyncState) => void = () => {},
    private notify: (msg: string) => void = () => {},
    private extras: SyncExtras = {},
  ) {
    if (extras.warnBytes !== undefined) {
      engine.setFileGuard({
        warnBytes: extras.warnBytes,
        excludeBytes: extras.excludeBytes ?? HOST_FILE_LIMIT_BYTES,
        onWarn: (path, size) => {
          if (this.warned.has(path)) return;
          this.warned.add(path);
          this.log("warn", `Large file: ${path} (${(size / MB).toFixed(1)} MB)`);
          this.notify(`${path} is ${(size / MB).toFixed(0)} MB. Big files slow syncing, especially on mobile.`);
        },
        onExclude: (path, size) => {
          if (this.excludedNotified.has(path)) return; // a tracked file that grew stays "changed" every cycle
          this.excludedNotified.add(path);
          this.log("warn", `Not syncing ${path} (${(size / MB).toFixed(0)} MB, over the 100 MB host limit)`);
          this.notify(`${path} is ${(size / MB).toFixed(0)} MB, over the 100 MB limit git hosts accept. It will not be synced.`);
        },
      });
    }
  }

  private log(level: "info" | "warn" | "error", msg: string) {
    this.extras.log?.add(level, msg);
  }

  private set(s: SyncState) {
    this.state = s;
    this.onState(s);
  }

  private conflict(files: string[]): SyncState {
    this.log("warn", `Conflicts held for manual resolution: ${files.join(", ")}`);
    this.set({ kind: "conflict", files });
    return this.state;
  }

  /**
   * First sync between a vault and a remote that share no history. A new device (nothing but config)
   * just adopts the remote. If both sides hold real notes, ask before combining them.
   * Returns true if the merge may proceed.
   */
  private async approveUnrelated(): Promise<boolean> {
    if (this.unrelated === "approved") return true;
    if (this.unrelated === "declined") return false;
    if (isTrivialVault(await this.engine.trackedFiles())) {
      this.unrelated = "approved";
      return true;
    }
    this.log("warn", "Vault and remote have no shared history; asking before combining them.");
    const ok = this.extras.confirmUnrelated ? await this.extras.confirmUnrelated() : false;
    this.unrelated = ok ? "approved" : "declined";
    this.log("info", ok ? "Combining vault with remote (confirmed)." : "Declined to combine vault with remote.");
    return ok;
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
        if (await this.engine.finishMerge()) {
          this.log("info", "Merge concluded after conflict resolution.");
          this.notify("Conflicts resolved and merged.");
        }

        // Always commit local work first so merges run against a clean tree.
        if (await this.engine.commitAll(`vault sync: ${this.deviceName() || "device"} ${new Date().toISOString()}`)) {
          this.log("info", "Committed local changes.");
        }

        for (let attempt = 0; attempt < MAX_PUSH_RETRIES; attempt++) {
          await this.engine.fetch();
          if ((await this.engine.relationToRemote()) === "unrelated" && !(await this.approveUnrelated())) {
            this.set({ kind: "paused", reason: "This vault and the remote both have notes but no shared history." });
            return this.state;
          }
          const merged = await this.engine.mergeRemote();
          if (merged.kind !== "upToDate") this.log("info", `Merged remote changes (${merged.kind}).`);
          if (merged.kind === "conflicts") {
            const { remaining, notes } = await autoResolve(this.engine);
            for (const n of notes) {
              this.log("info", `Auto-resolved: ${n}`);
              this.notify(n);
            }
            if (remaining.length) return this.conflict(remaining);
            await this.engine.finishMerge();
          }
          const pushed = await this.engine.push();
          if (pushed.kind === "ok") {
            this.log("info", "Sync complete.");
            this.set({ kind: "idle", lastSync: Date.now() });
            return this.state;
          }
          this.log("warn", "Push rejected (remote moved); retrying.");
          await new Promise((r) => setTimeout(r, 200 + Math.random() * 800));
        }
        this.log("error", "Push kept being rejected.");
        this.set({ kind: "error", message: "Push kept being rejected; will retry." });
      } catch (e) {
        const message = friendlyError(e, this.extras.token?.() ?? "");
        this.log("error", message);
        this.set({ kind: "error", message });
      }
      return this.state;
    });
  }

  /** User chose a side for one conflicted file (from the conflict modal). Returns files still unresolved. */
  resolve(path: string, side: Side): Promise<string[]> {
    return this.mutex.run(async () => {
      await this.engine.takeSide(path, side);
      this.log("info", `Resolved ${path}: kept ${side === "ours" ? "local" : "remote"} version.`);
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
