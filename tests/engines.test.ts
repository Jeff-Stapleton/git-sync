import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as nodeFs from "fs";
import nodeHttp from "isomorphic-git/http/node";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliGitEngine } from "../src/git/CliGitEngine";
import type { GitEngine } from "../src/git/GitEngine";
import { IsoGitEngine } from "../src/git/IsoGitEngine";
import { createObsidianHttp, RequestUrlFn } from "../src/git/obsidianHttp";
import { createObsidianFs } from "../src/git/obsidianFs";
import { SyncExtras, SyncManager } from "../src/sync/SyncManager";
import { startRemote, TestRemote } from "./helpers/gitHttpServer";
import { nodeAdapter } from "./helpers/nodeAdapter";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd }).toString();

/** requestUrl stand-in backed by fetch, so the Obsidian HTTP client's conversions run for real. */
const fetchRequestUrl: RequestUrlFn = async (p) => {
  const r = await fetch(p.url, { method: p.method, headers: p.headers, body: p.body ? Buffer.from(p.body) : undefined });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { status: r.status, headers, arrayBuffer: await r.arrayBuffer() };
};

type Kind = "cli" | "iso" | "iso-obsidian";

function makeEngine(kind: Kind, dir: string, name: string): GitEngine {
  if (kind === "cli") {
    git(dir, "init", "-b", "main");
    git(dir, "config", "user.email", `${name}@test`);
    git(dir, "config", "user.name", name);
    return new CliGitEngine(dir);
  }
  if (kind === "iso") return new IsoGitEngine({ fs: nodeFs, http: nodeHttp, dir });
  return new IsoGitEngine({ fs: createObsidianFs(nodeAdapter(dir)), http: createObsidianHttp(fetchRequestUrl), dir: "/" });
}

describe.each<Kind>(["cli", "iso", "iso-obsidian"])("engine: %s", (kind) => {
  let remote: TestRemote;
  beforeEach(async () => { remote = await startRemote(); });
  afterEach(async () => { await remote.close(); });

  function device(name: string, opts: { dir?: string; token?: string; extras?: SyncExtras; notes?: string[] } = {}) {
    const dir = opts.dir ?? mkdtempSync(join(tmpdir(), `vault-${name}-`));
    const engine = makeEngine(kind, dir, name);
    return {
      dir, engine,
      ready: engine.ensureRepo({
        remoteUrl: remote.url, branch: "main", token: opts.token ?? remote.token,
        author: { name, email: `${name}@test` },
      }),
      sync: new SyncManager(engine, () => name, () => {}, (m) => opts.notes?.push(m), opts.extras),
    };
  }
  const read = (d: { dir: string }, f: string) => readFileSync(join(d.dir, f), "utf8");

  it("propagates a note between two devices", async () => {
    const a = device("a"), b = device("b");
    await a.ready; await b.ready;
    writeFileSync(join(a.dir, "note.md"), "hello\n");
    const s1 = await a.sync.sync();
    expect(s1, JSON.stringify(s1)).toMatchObject({ kind: "idle" });
    const s2 = await b.sync.sync();
    expect(s2, JSON.stringify(s2)).toMatchObject({ kind: "idle" });
    expect(read(b, "note.md")).toBe("hello\n");
  });

  it("merges non-conflicting concurrent edits", async () => {
    const a = device("a"), b = device("b");
    await a.ready; await b.ready;
    writeFileSync(join(a.dir, "one.md"), "1\n");
    await a.sync.sync(); await b.sync.sync();
    writeFileSync(join(a.dir, "a.md"), "from a\n");
    writeFileSync(join(b.dir, "b.md"), "from b\n");
    await a.sync.sync(); await b.sync.sync(); await a.sync.sync();
    for (const d of [a, b]) {
      expect(read(d, "a.md")).toBe("from a\n");
      expect(read(d, "b.md")).toBe("from b\n");
    }
  });

  it("auto-merges edits to different parts of the same note", async () => {
    const a = device("a"), b = device("b");
    await a.ready; await b.ready;
    writeFileSync(join(a.dir, "n.md"), "1\n2\n3\n4\n5\n");
    await a.sync.sync(); await b.sync.sync();
    writeFileSync(join(a.dir, "n.md"), "ONE\n2\n3\n4\n5\n");
    writeFileSync(join(b.dir, "n.md"), "1\n2\n3\n4\nFIVE\n");
    await a.sync.sync();
    expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
    await a.sync.sync();
    for (const d of [a, b]) expect(read(d, "n.md")).toBe("ONE\n2\n3\n4\nFIVE\n");
  });

  it("first sync of a fresh vault with its own initial commit merges unrelated histories", async () => {
    const a = device("a"), b = device("b", { extras: { confirmUnrelated: async () => true } });
    await a.ready; await b.ready;
    writeFileSync(join(a.dir, "remote.md"), "on remote\n");
    writeFileSync(join(a.dir, ".gitignore"), ".DS_Store\n");
    await a.sync.sync();
    // b already has local content (e.g. the plugin's own .gitignore) before ever syncing
    writeFileSync(join(b.dir, "local.md"), "only local\n");
    writeFileSync(join(b.dir, ".gitignore"), ".DS_Store\n");
    const s = await b.sync.sync();
    expect(s, JSON.stringify(s)).toMatchObject({ kind: "idle" });
    expect(read(b, "remote.md")).toBe("on remote\n");
    await a.sync.sync();
    expect(read(a, "local.md")).toBe("only local\n");
  });

  it("reports same-line conflicts with markers and holds sync", async () => {
    const a = device("a"), b = device("b");
    await a.ready; await b.ready;
    writeFileSync(join(a.dir, "n.md"), "base\n");
    await a.sync.sync(); await b.sync.sync();
    writeFileSync(join(a.dir, "n.md"), "from a\n");
    writeFileSync(join(b.dir, "n.md"), "from b\n");
    await a.sync.sync();
    expect((await b.sync.sync()).kind).toBe("conflict");
    expect(read(b, "n.md")).toContain("<<<<<<<");
    expect((await b.sync.sync()).kind).toBe("conflict"); // still held
  });

  it("applies non-conflicting changes from the same merge that conflicts (add, edit, delete)", async () => {
    const a = device("a"), b = device("b");
    await a.ready; await b.ready;
    writeFileSync(join(a.dir, "n.md"), "base\n");
    writeFileSync(join(a.dir, "gone.md"), "delete me\n");
    writeFileSync(join(a.dir, "edit.md"), "v1\n");
    await a.sync.sync(); await b.sync.sync();
    writeFileSync(join(a.dir, "n.md"), "from a\n");
    writeFileSync(join(a.dir, "new.md"), "new from a\n");
    writeFileSync(join(a.dir, "edit.md"), "v2\n");
    rmSync(join(a.dir, "gone.md"));
    writeFileSync(join(b.dir, "n.md"), "from b\n");
    await a.sync.sync();
    expect((await b.sync.sync()).kind).toBe("conflict");
    expect(read(b, "new.md")).toBe("new from a\n");
    expect(read(b, "edit.md")).toBe("v2\n");
    expect(readdirSync(b.dir)).not.toContain("gone.md");
    writeFileSync(join(b.dir, "n.md"), "resolved\n");
    expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
    await a.sync.sync();
    for (const d of [a, b]) {
      expect(read(d, "n.md")).toBe("resolved\n");
      expect(readdirSync(d.dir)).not.toContain("gone.md");
    }
    expect(git(b.dir, "status", "--porcelain").trim()).toBe("");
  });

  it("keeps conflicts across a restart (fresh engine on the same vault)", async () => {
    const a = device("a"), b = device("b");
    await a.ready; await b.ready;
    writeFileSync(join(a.dir, "n.md"), "base\n");
    await a.sync.sync(); await b.sync.sync();
    writeFileSync(join(a.dir, "n.md"), "from a\n");
    writeFileSync(join(b.dir, "n.md"), "from b\n");
    await a.sync.sync(); await b.sync.sync();
    const b2 = device("b", { dir: b.dir });
    await b2.ready;
    // (cli engine's makeEngine re-inits, which is a no-op on an existing repo)
    expect(await b2.sync.sync()).toMatchObject({ kind: "conflict", files: ["n.md"] });
  });

  it("wrong token reports an error and never pushes", async () => {
    const a = device("a", { token: "wrong" });
    await a.ready;
    writeFileSync(join(a.dir, "n.md"), "secret\n");
    const s = await a.sync.sync();
    expect(s.kind).toBe("error");
    expect(remote.unauthorized).toBeGreaterThan(0);
  });

  it("untrack removes an already-committed secret from the index but keeps the file", async () => {
    const a = device("a");
    await a.ready;
    mkdirSync(join(a.dir, ".obsidian/plugins/git-sync"), { recursive: true });
    const secret = join(a.dir, ".obsidian/plugins/git-sync/data.json");
    writeFileSync(secret, '{"token":"x"}');
    await a.sync.sync();
    expect(git(a.dir, "ls-files")).toContain("data.json");
    writeFileSync(join(a.dir, ".gitignore"), ".obsidian/plugins/git-sync/data.json\n");
    await a.engine.untrack([".obsidian/plugins/git-sync/data.json"]);
    await a.sync.sync();
    expect(git(a.dir, "ls-files")).not.toContain("data.json");
    expect(readFileSync(secret, "utf8")).toContain("token");
  });

  describe("connection, first sync and large files", () => {
    it("testConnection: reports branch state and rejects a bad token", async () => {
      const a = device("a");
      await a.ready;
      const cfg = { remoteUrl: remote.url, branch: "main", token: remote.token };
      expect(await a.engine.testConnection(cfg)).toEqual({ branchExists: false }); // empty remote
      writeFileSync(join(a.dir, "n.md"), "x\n");
      await a.sync.sync();
      expect(await a.engine.testConnection(cfg)).toEqual({ branchExists: true });
      expect(await a.engine.testConnection({ ...cfg, branch: "other" })).toEqual({ branchExists: false });
      await expect(a.engine.testConnection({ ...cfg, token: "wrong" })).rejects.toThrow();
    });

    it("trackedFiles lists committed paths only", async () => {
      const a = device("a");
      await a.ready;
      expect(await a.engine.trackedFiles()).toEqual([]); // unborn
      mkdirSync(join(a.dir, "d"));
      writeFileSync(join(a.dir, "d/n.md"), "x\n");
      await a.sync.sync();
      writeFileSync(join(a.dir, "uncommitted.md"), "y\n");
      expect(await a.engine.trackedFiles()).toEqual(["d/n.md"]);
    });

    async function twoVaultsWithNotes(bExtras: SyncExtras) {
      const a = device("a"), b = device("b", { extras: bExtras });
      await a.ready; await b.ready;
      writeFileSync(join(a.dir, "from-a.md"), "a\n");
      await a.sync.sync();
      writeFileSync(join(b.dir, "from-b.md"), "b\n"); // b has its own notes and no shared history
      return { a, b };
    }

    it("declined: pauses, does not push, and does not re-prompt on later syncs", async () => {
      let asked = 0;
      const { a, b } = await twoVaultsWithNotes({ confirmUnrelated: async () => (asked++, false) });
      expect(await b.sync.sync()).toMatchObject({ kind: "paused" });
      expect(await b.sync.sync()).toMatchObject({ kind: "paused" });
      expect(asked).toBe(1);
      await a.sync.sync();
      expect(readdirSync(a.dir)).not.toContain("from-b.md");
      expect(readdirSync(b.dir)).not.toContain("from-a.md");
    });

    it("confirmed: combines both note collections", async () => {
      const { a, b } = await twoVaultsWithNotes({ confirmUnrelated: async () => true });
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      await a.sync.sync();
      for (const d of [a, b]) {
        expect(read(d, "from-a.md")).toBe("a\n");
        expect(read(d, "from-b.md")).toBe("b\n");
      }
    });

    it("a new device with only config files adopts the remote without asking", async () => {
      const a = device("a");
      await a.ready;
      writeFileSync(join(a.dir, "from-a.md"), "a\n");
      await a.sync.sync();
      let asked = 0;
      const b = device("b", { extras: { confirmUnrelated: async () => (asked++, false) } });
      await b.ready;
      mkdirSync(join(b.dir, ".obsidian"));
      writeFileSync(join(b.dir, ".obsidian/app.json"), "{}\n");
      writeFileSync(join(b.dir, ".gitignore"), ".DS_Store\n");
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      expect(asked).toBe(0);
      expect(read(b, "from-a.md")).toBe("a\n");
    });

    it("large files: warns once but syncs; over the host limit is kept out of sync", async () => {
      const notes: string[] = [];
      const a = device("a", { notes, extras: { warnBytes: 20, excludeBytes: 100 } }), b = device("b");
      await a.ready; await b.ready;
      writeFileSync(join(a.dir, "small.md"), "tiny\n");
      writeFileSync(join(a.dir, "warn.md"), "w".repeat(50));
      writeFileSync(join(a.dir, "huge.bin"), "h".repeat(500));
      expect(await a.sync.sync()).toMatchObject({ kind: "idle" });
      await a.sync.sync(); // second cycle must not repeat notices or create empty commits
      const commits = git(a.dir, "rev-list", "--count", "HEAD").trim();
      await a.sync.sync();
      expect(git(a.dir, "rev-list", "--count", "HEAD").trim()).toBe(commits);
      expect(notes.filter((n) => n.includes("warn.md"))).toHaveLength(1);
      expect(notes.filter((n) => n.includes("huge.bin"))).toHaveLength(1);
      await b.sync.sync();
      expect(readdirSync(b.dir)).toEqual(expect.arrayContaining(["small.md", "warn.md"]));
      expect(readdirSync(b.dir)).not.toContain("huge.bin");
      expect(readdirSync(a.dir)).toContain("huge.bin"); // still on disk locally
    });

    it("large files: a tracked file that later grows past the limit stops syncing but keeps its old remote version", async () => {
      const notes: string[] = [];
      const a = device("a", { notes, extras: { warnBytes: 1000, excludeBytes: 100 } }), b = device("b");
      await a.ready; await b.ready;
      writeFileSync(join(a.dir, "grow.md"), "small\n");
      await a.sync.sync();
      writeFileSync(join(a.dir, "grow.md"), "g".repeat(500));
      writeFileSync(join(a.dir, "other.md"), "still syncs\n");
      expect(await a.sync.sync()).toMatchObject({ kind: "idle" });
      expect(await a.sync.sync()).toMatchObject({ kind: "idle" });
      expect(notes.filter((n) => n.includes("grow.md"))).toHaveLength(1);
      await b.sync.sync();
      expect(read(b, "grow.md")).toBe("small\n");
      expect(read(b, "other.md")).toBe("still syncs\n");
    });
  });

  describe("conflict policies", () => {
    async function diverge(setupA: (dir: string) => void, setupB: (dir: string) => void, base: (dir: string) => void) {
      const a = device("a"), b = device("b");
      await a.ready; await b.ready;
      base(a.dir);
      await a.sync.sync(); await b.sync.sync();
      setupA(a.dir); setupB(b.dir);
      await a.sync.sync();
      return { a, b };
    }
    const png = (n: number) => Buffer.from([137, 80, 78, 71, 0, n]);
    const base = "base\n", A = "from a\n", B = "from b\n";
    const md = (d: string, c: string) => writeFileSync(join(d, "n.md"), c);

    it("keeps local binary and saves the remote version as a conflict copy", async () => {
      const { a, b } = await diverge(
        (d) => writeFileSync(join(d, "p.png"), png(1)),
        (d) => writeFileSync(join(d, "p.png"), png(2)),
        (d) => writeFileSync(join(d, "p.png"), png(0)),
      );
      const s = await b.sync.sync();
      expect(s, JSON.stringify(s)).toMatchObject({ kind: "idle" });
      expect(readFileSync(join(b.dir, "p.png"))).toEqual(png(2));
      const copy = readdirSync(b.dir).find((f) => f.startsWith("p.conflict-remote-"))!;
      expect(readFileSync(join(b.dir, copy))).toEqual(png(1));
      await a.sync.sync();
      expect(readdirSync(a.dir).some((f) => f.startsWith("p.conflict-remote-"))).toBe(true);
    });

    it("delete vs modify keeps the modified file (deleted here)", async () => {
      const { b } = await diverge((d) => md(d, "edited on a\n"), (d) => rmSync(join(d, "n.md")), (d) => md(d, base));
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      expect(read(b, "n.md")).toBe("edited on a\n");
    });

    it("delete vs modify keeps the modified file (deleted there)", async () => {
      const { b } = await diverge((d) => rmSync(join(d, "n.md")), (d) => md(d, "edited on b\n"), (d) => md(d, base));
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      expect(read(b, "n.md")).toBe("edited on b\n");
    });

    it("remote wins for .obsidian config conflicts", async () => {
      const { b } = await diverge(
        (d) => writeFileSync(join(d, ".obsidian/app.json"), '{"a":1}\n'),
        (d) => writeFileSync(join(d, ".obsidian/app.json"), '{"b":2}\n'),
        (d) => { mkdirSync(join(d, ".obsidian")); writeFileSync(join(d, ".obsidian/app.json"), "{}\n"); },
      );
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      expect(read(b, ".obsidian/app.json")).toBe('{"a":1}\n');
    });

    it("finishes the merge once the user removes the markers by hand", async () => {
      const { a, b } = await diverge((d) => md(d, A), (d) => md(d, B), (d) => md(d, base));
      expect(await b.sync.sync()).toMatchObject({ kind: "conflict", files: ["n.md"] });
      md(b.dir, "from a and b\n");
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      await a.sync.sync();
      expect(read(a, "n.md")).toBe("from a and b\n");
      expect(git(b.dir, "status", "--porcelain").trim()).toBe("");
    });

    it("resolve('ours') that equals HEAD still concludes the merge and pushes", async () => {
      const { a, b } = await diverge((d) => md(d, A), (d) => md(d, B), (d) => md(d, base));
      await b.sync.sync();
      expect(await b.sync.resolve("n.md", "ours")).toEqual([]);
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      await a.sync.sync();
      expect(read(a, "n.md")).toBe(B);
    });

    it("resolve('theirs') takes the remote content", async () => {
      const { b } = await diverge((d) => md(d, A), (d) => md(d, B), (d) => md(d, base));
      await b.sync.sync();
      await b.sync.resolve("n.md", "theirs");
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      expect(read(b, "n.md")).toBe(A);
    });
  });
});
