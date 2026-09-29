import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
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
});
