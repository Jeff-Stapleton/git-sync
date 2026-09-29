import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { CliGitEngine } from "../src/git/CliGitEngine";
import { SyncManager } from "../src/sync/SyncManager";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd }).toString();

function device(remote: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), `vault-${name}-`));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", `${name}@test`);
  git(dir, "config", "user.name", name);
  const engine = new CliGitEngine(dir);
  return { dir, engine, ready: engine.ensureRepo({ remoteUrl: remote, branch: "main", token: "" }), sync: new SyncManager(engine, () => name) };
}

describe("CliGitEngine + SyncManager", () => {
  let remote: string;
  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), "remote-"));
    git(remote, "init", "--bare", "-b", "main");
  });

  it("propagates a note between two devices", async () => {
    const a = device(remote, "a"), b = device(remote, "b");
    await a.ready; await b.ready;
    writeFileSync(join(a.dir, "note.md"), "hello\n");
    const s1 = await a.sync.sync();
    expect(s1, JSON.stringify(s1)).toMatchObject({ kind: "idle" });
    const s2 = await b.sync.sync();
    expect(s2, JSON.stringify(s2)).toMatchObject({ kind: "idle" });
    expect(readFileSync(join(b.dir, "note.md"), "utf8")).toBe("hello\n");
  });

  it("merges non-conflicting concurrent edits", async () => {
    const a = device(remote, "a"), b = device(remote, "b");
    await a.ready; await b.ready;
    writeFileSync(join(a.dir, "one.md"), "1\n");
    await a.sync.sync(); await b.sync.sync();
    writeFileSync(join(a.dir, "a.md"), "from a\n");
    writeFileSync(join(b.dir, "b.md"), "from b\n");
    await a.sync.sync(); await b.sync.sync(); await a.sync.sync();
    for (const d of [a, b]) {
      expect(readFileSync(join(d.dir, "a.md"), "utf8")).toBe("from a\n");
      expect(readFileSync(join(d.dir, "b.md"), "utf8")).toBe("from b\n");
    }
  });

  it("reports same-line conflicts with markers and holds sync", async () => {
    const a = device(remote, "a"), b = device(remote, "b");
    await a.ready; await b.ready;
    writeFileSync(join(a.dir, "n.md"), "base\n");
    await a.sync.sync(); await b.sync.sync();
    writeFileSync(join(a.dir, "n.md"), "from a\n");
    writeFileSync(join(b.dir, "n.md"), "from b\n");
    await a.sync.sync();
    const s = await b.sync.sync();
    expect(s.kind).toBe("conflict");
    expect(readFileSync(join(b.dir, "n.md"), "utf8")).toContain("<<<<<<<");
    expect((await b.sync.sync()).kind).toBe("conflict"); // still held
  });

  it("untrack removes an already-committed secret from the index but keeps the file", async () => {
    const a = device(remote, "a");
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

  describe("conflict policies", () => {
    async function diverge(setupA: (dir: string) => void, setupB: (dir: string) => void, base: (dir: string) => void) {
      const a = device(remote, "a"), b = device(remote, "b");
      await a.ready; await b.ready;
      base(a.dir);
      await a.sync.sync(); await b.sync.sync();
      setupA(a.dir); setupB(b.dir);
      await a.sync.sync();
      return { a, b };
    }
    const png = (n: number) => Buffer.from([137, 80, 78, 71, 0, n]);

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
      await a.sync.sync(); // copy reaches the other device
      expect(readdirSync(a.dir).some((f) => f.startsWith("p.conflict-remote-"))).toBe(true);
    });

    it("delete vs modify keeps the modified file", async () => {
      const { b } = await diverge(
        (d) => rmSync(join(d, "n.md")),
        (d) => writeFileSync(join(d, "n.md"), "edited on b\n"),
        (d) => writeFileSync(join(d, "n.md"), "base\n"),
      );
      const s = await b.sync.sync();
      expect(s, JSON.stringify(s)).toMatchObject({ kind: "idle" });
      expect(readFileSync(join(b.dir, "n.md"), "utf8")).toBe("edited on b\n");
    });

    it("remote wins for .obsidian config conflicts", async () => {
      const { b } = await diverge(
        (d) => writeFileSync(join(d, ".obsidian/app.json"), '{"a":1}\n'),
        (d) => writeFileSync(join(d, ".obsidian/app.json"), '{"b":2}\n'),
        (d) => { mkdirSync(join(d, ".obsidian")); writeFileSync(join(d, ".obsidian/app.json"), "{}\n"); },
      );
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      expect(readFileSync(join(b.dir, ".obsidian/app.json"), "utf8")).toBe('{"a":1}\n');
    });

    it("finishes the merge once the user removes the markers by hand", async () => {
      const { a, b } = await diverge(
        (d) => writeFileSync(join(d, "n.md"), "from a\n"),
        (d) => writeFileSync(join(d, "n.md"), "from b\n"),
        (d) => writeFileSync(join(d, "n.md"), "base\n"),
      );
      expect(await b.sync.sync()).toMatchObject({ kind: "conflict", files: ["n.md"] });
      writeFileSync(join(b.dir, "n.md"), "from a and b\n");
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      await a.sync.sync();
      expect(readFileSync(join(a.dir, "n.md"), "utf8")).toBe("from a and b\n");
      expect(git(b.dir, "status", "--porcelain").trim()).toBe("");
    });

    it("resolve('ours') that equals HEAD still concludes the merge and pushes", async () => {
      const { a, b } = await diverge(
        (d) => writeFileSync(join(d, "n.md"), "from a\n"),
        (d) => writeFileSync(join(d, "n.md"), "from b\n"),
        (d) => writeFileSync(join(d, "n.md"), "base\n"),
      );
      await b.sync.sync();
      expect(await b.sync.resolve("n.md", "ours")).toEqual([]);
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      await a.sync.sync();
      expect(readFileSync(join(a.dir, "n.md"), "utf8")).toBe("from b\n");
    });

    it("resolve('theirs') takes the remote content", async () => {
      const { b } = await diverge(
        (d) => writeFileSync(join(d, "n.md"), "from a\n"),
        (d) => writeFileSync(join(d, "n.md"), "from b\n"),
        (d) => writeFileSync(join(d, "n.md"), "base\n"),
      );
      await b.sync.sync();
      await b.sync.resolve("n.md", "theirs");
      expect(await b.sync.sync()).toMatchObject({ kind: "idle" });
      expect(readFileSync(join(b.dir, "n.md"), "utf8")).toBe("from a\n");
    });
  });
});
