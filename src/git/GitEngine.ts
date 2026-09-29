export type MergeResult =
  | { kind: "upToDate" }
  | { kind: "clean" }
  | { kind: "conflicts"; files: string[] };

export type ConflictKind = "both-modified" | "both-added" | "deleted-by-us" | "deleted-by-them";

export interface ConflictInfo {
  path: string;
  kind: ConflictKind;
  /** Only meaningful when both sides have content. */
  binary: boolean;
}

export type Side = "ours" | "theirs";

export type PushResult = { kind: "ok" } | { kind: "rejectedNonFF" };

export interface RepoConfig {
  remoteUrl: string;
  branch: string;
  token: string;
  /** Commit identity for engines that don't read git config (defaults to a generic plugin identity). */
  author?: { name: string; email: string };
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
  /** Stop tracking paths (keeps files on disk). Used so ignored secrets never get pushed. */
  untrack(paths: string[]): Promise<void>;
  /** Unmerged paths with what kind of conflict each is. */
  conflicts(): Promise<ConflictInfo[]>;
  /** Resolve a path by taking one side wholesale (deleting it if that side deleted it). Stages the result. */
  takeSide(path: string, side: Side): Promise<void>;
  /** Mark a path resolved using whatever is in the working tree now (including deletion). */
  stageResolved(path: string): Promise<void>;
  /** Content of a side of a conflict (null if that side has no file). */
  readSide(path: string, side: Side): Promise<Uint8Array | null>;
  readWorkFile(path: string): Promise<Uint8Array | null>;
  writeWorkFile(path: string, data: Uint8Array): Promise<void>;
  /** Commit the in-progress merge if every conflict is resolved. Returns true if a merge commit was made. */
  finishMerge(): Promise<boolean>;
  /** True if remote branch has commits we don't have (after fetch). */
  isBehind(): Promise<boolean>;
}
