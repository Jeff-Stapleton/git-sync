export type MergeResult =
  | { kind: "upToDate" }
  | { kind: "clean" }
  | { kind: "conflicts"; files: string[] };

export type PushResult = { kind: "ok" } | { kind: "rejectedNonFF" };

export interface RepoConfig {
  remoteUrl: string;
  branch: string;
  token: string;
}

export interface GitEngine {
  readonly name: string;
  /** Ensure the vault is a repo with `origin` set to the configured URL. */
  ensureRepo(cfg: RepoConfig): Promise<void>;
  hasChanges(): Promise<boolean>;
  /** Stage everything (respecting .gitignore) and commit. Returns false if nothing to commit. */
  commitAll(message: string): Promise<boolean>;
  fetch(): Promise<void>;
  /** Merge origin/<branch> into HEAD. Conflicts leave standard markers in the working tree. */
  mergeRemote(): Promise<MergeResult>;
  push(): Promise<PushResult>;
  abortMerge(): Promise<void>;
  conflictedFiles(): Promise<string[]>;
  /** True if remote branch has commits we don't have (after fetch). */
  isBehind(): Promise<boolean>;
}
