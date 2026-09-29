import git, { HttpClient, TREE } from "isomorphic-git";
import { isBinary } from "../util/markers";
import { mergeText } from "../util/textMerge";
import { ConflictInfo, GitEngine, MergeResult, PushResult, RepoConfig, Side } from "./GitEngine";

/**
 * Pure-JS engine for platforms without a git binary (Obsidian mobile).
 *
 * isomorphic-git's own `merge` is not used: it leaves the working tree/index stale after clean
 * merges, applies conflicting merges only partially, and rejects unrelated histories. Instead the
 * merge is an explicit 3-way tree merge (see mergeRemote) built on its walk/blob/add primitives.
 */

interface MergeState {
  ours: string;
  theirs: string;
  conflicts: ConflictInfo[];
}

export interface IsoGitOptions {
  /** isomorphic-git fs (Node `fs`, or createObsidianFs). Must expose `promises`. */
  fs: any;
  http: HttpClient;
  /** Working tree root as seen by `fs` ("/" for the Obsidian fs bridge). */
  dir?: string;
}

const DEFAULT_AUTHOR = { name: "Obsidian Git Sync", email: "obsidian-git-sync@localhost" };
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);
const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

export class IsoGitEngine implements GitEngine {
  readonly name = "isomorphic-git";
  private cfg?: RepoConfig;
  private fs: any;
  private http: HttpClient;
  private dir: string;
  /**
   * Files added to the index within the last couple of seconds. isomorphic-git's change detection
   * compares mtimes at 1-second resolution, so a same-size edit in the same second as an add is
   * invisible to statusMatrix (and would silently never sync). Like git's "racy" entries, these are
   * re-hashed before the next status check.
   */
  private racy = new Set<string>();

  constructor(opts: IsoGitOptions) {
    this.fs = opts.fs;
    this.http = opts.http;
    this.dir = opts.dir ?? "/";
  }

  private get ctx() {
    return { fs: this.fs, dir: this.dir };
  }
  private get author() {
    return this.cfg?.author ?? DEFAULT_AUTHOR;
  }
  private abs(rel: string) {
    return (this.dir === "/" ? "" : this.dir.replace(/\/$/, "")) + "/" + rel;
  }
  private headers(): Record<string, string> {
    const t = this.cfg?.token;
    return t ? { Authorization: "Basic " + btoa(`x-access-token:${t}`) } : {};
  }

  // ---- working-tree file helpers -------------------------------------------------------------

  private async readWork(rel: string): Promise<Uint8Array | null> {
    try {
      return await this.fs.promises.readFile(this.abs(rel));
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }

  private async ensureDir(rel: string): Promise<void> {
    if (!rel) return;
    try {
      await this.fs.promises.mkdir(this.abs(rel));
    } catch (e: any) {
      if (e?.code === "EEXIST") return;
      if (e?.code !== "ENOENT") throw e;
      await this.ensureDir(parentOf(rel));
      try {
        await this.fs.promises.mkdir(this.abs(rel));
      } catch (e2: any) {
        if (e2?.code !== "EEXIST") throw e2;
      }
    }
  }

  private async writeWork(rel: string, data: Uint8Array): Promise<void> {
    await this.ensureDir(parentOf(rel));
    await this.fs.promises.writeFile(this.abs(rel), data);
  }

  private async unlinkWork(rel: string): Promise<void> {
    try {
      await this.fs.promises.unlink(this.abs(rel));
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }

  private async addPaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    await git.add({ ...this.ctx, filepath: paths });
    if (paths.length > 200) return; // bulk imports are old files; skip the per-file stat cost
    const now = Date.now();
    for (const p of paths) {
      try {
        const st = await this.fs.promises.stat(this.abs(p));
        if (now - st.mtimeMs < 2000) this.racy.add(p);
      } catch {
        /* removed since */
      }
    }
  }

  private async refreshRacy(): Promise<void> {
    if (!this.racy.size) return;
    const paths = [...this.racy];
    this.racy.clear();
    const present: string[] = [];
    for (const p of paths) if ((await this.readWork(p)) !== null) present.push(p);
    await this.addPaths(present); // re-registers any still within the window
  }

  // ---- merge state (persisted in .git so it survives restarts) ---------------------------------

  private get statePath() {
    return this.abs(".git/gitsync-merge.json");
  }
  private async loadState(): Promise<MergeState | null> {
    try {
      return JSON.parse(await this.fs.promises.readFile(this.statePath, "utf8"));
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }
  private saveState(s: MergeState) {
    return this.fs.promises.writeFile(this.statePath, JSON.stringify(s));
  }
  private async clearState() {
    try {
      await this.fs.promises.unlink(this.statePath);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }

  // ---- refs ------------------------------------------------------------------------------------

  private async headOid(): Promise<string | undefined> {
    try {
      return await git.resolveRef({ ...this.ctx, ref: "HEAD" });
    } catch (e: any) {
      if (e?.code === "NotFoundError") return undefined;
      throw e;
    }
  }
  private async remoteOid(): Promise<string | undefined> {
    try {
      return await git.resolveRef({ ...this.ctx, ref: `refs/remotes/origin/${this.cfg!.branch}` });
    } catch (e: any) {
      if (e?.code === "NotFoundError") return undefined;
      throw e;
    }
  }
  private async localBranch(): Promise<string> {
    return (await git.currentBranch({ ...this.ctx })) || this.cfg!.branch;
  }
  private async blobAt(commit: string, path: string): Promise<Uint8Array | null> {
    try {
      return (await git.readBlob({ ...this.ctx, oid: commit, filepath: path })).blob;
    } catch (e: any) {
      if (e?.code === "NotFoundError") return null;
      throw e;
    }
  }

  // ---- GitEngine -------------------------------------------------------------------------------

  async ensureRepo(cfg: RepoConfig): Promise<void> {
    this.cfg = cfg;
    let exists = true;
    try {
      await this.fs.promises.stat(this.abs(".git"));
    } catch {
      exists = false;
    }
    if (!exists) await git.init({ ...this.ctx, defaultBranch: cfg.branch });
    await git.addRemote({ ...this.ctx, remote: "origin", url: cfg.remoteUrl, force: true });
  }

  async hasChanges(): Promise<boolean> {
    await this.refreshRacy();
    const rows = await git.statusMatrix({ ...this.ctx });
    return rows.some(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));
  }

  async commitAll(message: string): Promise<boolean> {
    await this.refreshRacy();
    const rows = await git.statusMatrix({ ...this.ctx });
    const toAdd: string[] = [];
    let changed = 0;
    for (const [file, h, w, s] of rows) {
      if (h === 1 && w === 1 && s === 1) continue;
      changed++;
      if (w === 0) await git.remove({ ...this.ctx, filepath: file });
      else toAdd.push(file);
    }
    if (!changed) return false;
    await this.addPaths(toAdd);
    await git.commit({ ...this.ctx, message, author: this.author });
    return true;
  }

  async fetch(): Promise<void> {
    try {
      await git.fetch({
        ...this.ctx,
        http: this.http,
        remote: "origin",
        ref: this.cfg!.branch,
        singleBranch: true,
        tags: false,
        headers: this.headers(),
      });
    } catch (e: any) {
      // Empty remote (first push from a fresh vault): nothing to fetch yet.
      if (e?.code === "NotFoundError" && /find/i.test(String(e.message))) return;
      throw e;
    }
  }

  async isBehind(): Promise<boolean> {
    const remote = await this.remoteOid();
    if (!remote) return false;
    const head = await this.headOid();
    if (!head) return true;
    if (head === remote) return false;
    return !(await git.isDescendent({ ...this.ctx, oid: head, ancestor: remote, depth: -1 }));
  }

  /**
   * 3-way merge of origin/<branch> into HEAD. Per path, with o/t/b = ours/theirs/base blob ids:
   * unchanged or already equal -> nothing; only theirs changed -> take theirs; only ours changed -> keep;
   * both changed -> text 3-way merge (markers on overlap), binary or delete-vs-edit -> conflict.
   * Working tree and index are updated first; merge state is recorded last, so a crash midway leaves
   * plain local edits that the next sync re-merges to the same result.
   */
  async mergeRemote(): Promise<MergeResult> {
    if (!(await this.isBehind())) return { kind: "upToDate" };
    const branch = await this.localBranch();
    const theirs = (await this.remoteOid())!;
    const ours = await this.headOid();
    const ff = ours === undefined || (await git.isDescendent({ ...this.ctx, oid: theirs, ancestor: ours, depth: -1 }));

    let base: string | undefined = ours;
    if (ours && !ff) base = (await git.findMergeBase({ ...this.ctx, oids: [ours, theirs] }))[0];
    const empty = await git.writeTree({ ...this.ctx, tree: [] });

    const items: { path: string; o: string | null; t: string | null; b: string | null }[] = await git.walk({
      ...this.ctx,
      trees: [TREE({ ref: ours ?? empty }), TREE({ ref: theirs }), TREE({ ref: base ?? empty })],
      map: async (path, entries) => {
        if (path === ".") return;
        const ids = await Promise.all(
          entries.map(async (e) => ((e && (await e.type()) === "blob") ? await e.oid() : null)),
        );
        if (ids.every((i) => i === null)) return; // directories
        return { path, o: ids[0], t: ids[1], b: ids[2] };
      },
    });

    const writes = new Map<string, Uint8Array | null>(); // staged results (null = delete)
    const markerWrites = new Map<string, Uint8Array>(); // working-tree-only conflict files
    const conflicts: ConflictInfo[] = [];
    const blob = async (oid: string) => (await git.readBlob({ ...this.ctx, oid })).blob;

    for (const { path, o, t, b } of items) {
      if (o === t) continue;
      if (b === o) { writes.set(path, t === null ? null : await blob(t)); continue; }
      if (b === t) continue;
      const kind = b === null ? "both-added" : "both-modified";
      if (o === null) { conflicts.push({ path, kind: "deleted-by-us", binary: false }); continue; }
      if (t === null) { conflicts.push({ path, kind: "deleted-by-them", binary: false }); continue; }
      const [ob, tb, bb] = await Promise.all([blob(o), blob(t), b ? blob(b) : Promise.resolve(new Uint8Array())]);
      if (isBinary(ob) || isBinary(tb) || isBinary(bb)) {
        conflicts.push({ path, kind, binary: true });
        continue;
      }
      const m = mergeText(dec(ob), dec(bb), dec(tb));
      if (!m.conflict) writes.set(path, enc(m.text));
      else {
        markerWrites.set(path, enc(m.text));
        conflicts.push({ path, kind, binary: false });
      }
    }

    // Refuse to clobber a file the user edited since we committed (the CLI's `git merge` refuses too).
    for (const path of [...writes.keys(), ...markerWrites.keys()]) {
      const item = items.find((i) => i.path === path)!;
      const cur = await this.readWork(path);
      const curOid = cur ? (await git.hashBlob({ object: cur })).oid : null;
      if (curOid !== item.o && curOid !== item.t) {
        throw new Error(`"${path}" changed locally during sync; will retry.`);
      }
    }

    const toAdd: string[] = [];
    for (const [path, data] of writes) {
      if (data === null) {
        await this.unlinkWork(path);
        await git.remove({ ...this.ctx, filepath: path });
      } else {
        await this.writeWork(path, data);
        toAdd.push(path);
      }
    }
    await this.addPaths(toAdd);
    for (const [path, data] of markerWrites) await this.writeWork(path, data);

    if (ff) {
      await git.writeRef({ ...this.ctx, ref: `refs/heads/${branch}`, value: theirs, force: true });
      return { kind: "clean" };
    }
    await this.saveState({ ours: ours!, theirs, conflicts });
    if (conflicts.length === 0) {
      await this.finishMerge();
      return { kind: "clean" };
    }
    return { kind: "conflicts", files: conflicts.map((c) => c.path) };
  }

  async push(): Promise<PushResult> {
    if (!(await this.headOid())) return { kind: "ok" }; // nothing committed yet
    try {
      const r = await git.push({
        ...this.ctx,
        http: this.http,
        remote: "origin",
        ref: await this.localBranch(),
        remoteRef: this.cfg!.branch,
        headers: this.headers(),
      });
      if (!r.ok) {
        if (/non-fast-forward|fetch first|stale|rejected/i.test(String(r.error))) return { kind: "rejectedNonFF" };
        throw new Error(`push failed: ${r.error}`);
      }
      return { kind: "ok" };
    } catch (e: any) {
      if (e?.code === "PushRejectedError") return { kind: "rejectedNonFF" };
      throw e;
    }
  }

  async abortMerge(): Promise<void> {
    await git.checkout({ ...this.ctx, ref: await this.localBranch(), force: true });
    await this.clearState();
  }

  async conflictedFiles(): Promise<string[]> {
    return ((await this.loadState())?.conflicts ?? []).map((c) => c.path);
  }

  async conflicts(): Promise<ConflictInfo[]> {
    return (await this.loadState())?.conflicts ?? [];
  }

  private async resolved(path: string) {
    const st = await this.loadState();
    if (!st) return;
    st.conflicts = st.conflicts.filter((c) => c.path !== path);
    await this.saveState(st);
  }

  async readSide(path: string, side: Side): Promise<Uint8Array | null> {
    const st = await this.loadState();
    return st ? this.blobAt(side === "ours" ? st.ours : st.theirs, path) : null;
  }

  async takeSide(path: string, side: Side): Promise<void> {
    const data = await this.readSide(path, side);
    if (data === null) {
      await this.unlinkWork(path);
      await git.remove({ ...this.ctx, filepath: path });
    } else {
      await this.writeWork(path, data);
      await this.addPaths([path]);
    }
    await this.resolved(path);
  }

  async stageResolved(path: string): Promise<void> {
    if ((await this.readWork(path)) === null) await git.remove({ ...this.ctx, filepath: path });
    else await this.addPaths([path]);
    await this.resolved(path);
  }

  readWorkFile(path: string) {
    return this.readWork(path);
  }
  writeWorkFile(path: string, data: Uint8Array) {
    return this.writeWork(path, data);
  }

  async finishMerge(): Promise<boolean> {
    const st = await this.loadState();
    if (!st || st.conflicts.length) return false;
    await git.commit({
      ...this.ctx,
      message: `Merge remote-tracking branch 'origin/${this.cfg!.branch}'`,
      author: this.author,
      parent: [st.ours, st.theirs],
    });
    await this.clearState();
    return true;
  }

  async untrack(paths: string[]): Promise<void> {
    for (const filepath of paths) {
      try {
        await git.remove({ ...this.ctx, filepath });
      } catch {
        /* not tracked */
      }
    }
  }
}
