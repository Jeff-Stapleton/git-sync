import { spawn } from "child_process";
import { GitEngine, MergeResult, PushResult, RepoConfig } from "./GitEngine";

export class GitCommandError extends Error {
  constructor(public args: string[], public code: number | null, public stderr: string) {
    super(`git ${args[0]} failed (${code}): ${stderr.trim()}`);
  }
}

/** Desktop engine: shells out to the system `git` binary. */
export class CliGitEngine implements GitEngine {
  readonly name = "git-cli";
  private cfg?: RepoConfig;

  constructor(private cwd: string, private gitPath = "git") {}

  /** Token is passed via env config (not argv) so it never shows in `ps` or .git/config. */
  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (this.cfg?.token) {
      const basic = Buffer.from(`x-access-token:${this.cfg.token}`).toString("base64");
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.extraHeader";
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
    return env;
  }

  private exec(args: string[], okCodes: number[] = [0]): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.gitPath, args, { cwd: this.cwd, env: this.env() });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => {
        if (code !== null && okCodes.includes(code)) resolve({ code, out, err });
        else reject(new GitCommandError(args, code, err || out));
      });
    });
  }

  static async isAvailable(gitPath = "git"): Promise<boolean> {
    try {
      await new CliGitEngine(process.cwd(), gitPath).exec(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async ensureRepo(cfg: RepoConfig): Promise<void> {
    this.cfg = cfg;
    const inRepo = await this.exec(["rev-parse", "--git-dir"], [0, 128]);
    if (inRepo.code !== 0) await this.exec(["init", "-b", cfg.branch]);
    const remotes = (await this.exec(["remote"])).out.split("\n");
    if (remotes.includes("origin")) await this.exec(["remote", "set-url", "origin", cfg.remoteUrl]);
    else await this.exec(["remote", "add", "origin", cfg.remoteUrl]);
    // Keep merges non-interactive and history-preserving.
    await this.exec(["config", "pull.rebase", "false"]);
    await this.exec(["config", "core.quotepath", "false"]);
  }

  async untrack(paths: string[]): Promise<void> {
    await this.exec(["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ...paths]);
  }

  async hasChanges(): Promise<boolean> {
    return (await this.exec(["status", "--porcelain"])).out.trim().length > 0;
  }

  async commitAll(message: string): Promise<boolean> {
    if (!(await this.hasChanges())) return false;
    await this.exec(["add", "-A"]);
    const r = await this.exec(["commit", "-m", message], [0, 1]);
    return r.code === 0;
  }

  async fetch(): Promise<void> {
    try {
      await this.exec(["fetch", "origin", this.cfg!.branch]);
    } catch (e) {
      // Empty remote (first push from a fresh vault): nothing to fetch yet.
      if (e instanceof GitCommandError && /couldn't find remote ref/i.test(e.stderr)) return;
      throw e;
    }
  }

  private hasRemoteBranch(): Promise<boolean> {
    return this.exec(["rev-parse", "--verify", "-q", `origin/${this.cfg!.branch}`], [0, 1]).then((r) => r.code === 0);
  }

  async isBehind(): Promise<boolean> {
    if (!(await this.hasRemoteBranch())) return false;
    // Unborn HEAD (fresh vault, no commits yet): everything on the remote is new.
    const head = await this.exec(["rev-parse", "--verify", "-q", "HEAD"], [0, 1]);
    if (head.code !== 0) return true;
    const r = await this.exec(["rev-list", "--count", `HEAD..origin/${this.cfg!.branch}`]);
    return parseInt(r.out.trim(), 10) > 0;
  }

  async mergeRemote(): Promise<MergeResult> {
    if (!(await this.hasRemoteBranch())) return { kind: "upToDate" };
    if (!(await this.isBehind())) return { kind: "upToDate" };
    const ref = `origin/${this.cfg!.branch}`;
    const r = await this.exec(["merge", "--no-edit", "--allow-unrelated-histories", ref], [0, 1]);
    if (r.code === 0) return { kind: "clean" };
    const files = await this.conflictedFiles();
    if (files.length === 0) throw new GitCommandError(["merge"], 1, r.err || r.out);
    return { kind: "conflicts", files };
  }

  async push(): Promise<PushResult> {
    try {
      await this.exec(["push", "-u", "origin", `HEAD:${this.cfg!.branch}`]);
      return { kind: "ok" };
    } catch (e) {
      if (e instanceof GitCommandError && /non-fast-forward|fetch first|rejected/i.test(e.stderr)) {
        return { kind: "rejectedNonFF" };
      }
      throw e;
    }
  }

  async abortMerge(): Promise<void> {
    await this.exec(["merge", "--abort"], [0, 128]);
  }

  async conflictedFiles(): Promise<string[]> {
    const r = await this.exec(["diff", "--name-only", "--diff-filter=U"]);
    return r.out.split("\n").filter(Boolean);
  }
}
