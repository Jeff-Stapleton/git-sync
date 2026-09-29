// Bundled with the real plugin build options and run in a process with NO global Buffer,
// standing in for mobile Obsidian. Uses only the pieces that run on mobile.
import { IsoGitEngine } from "../../src/git/IsoGitEngine";
import { createObsidianFs, MinimalAdapter } from "../../src/git/obsidianFs";
import { createObsidianHttp, RequestUrlFn } from "../../src/git/obsidianHttp";
import { SyncManager } from "../../src/sync/SyncManager";

export async function run(
  adapters: { a: MinimalAdapter; b: MinimalAdapter },
  requestUrl: RequestUrlFn,
  url: string,
  token: string,
) {
  const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
  const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);
  const mk = (adapter: MinimalAdapter, name: string) => {
    const engine = new IsoGitEngine({ fs: createObsidianFs(adapter), http: createObsidianHttp(requestUrl), dir: "/" });
    return {
      adapter,
      ready: engine.ensureRepo({ remoteUrl: url, branch: "main", token, author: { name: name, email: `${name}@t` } }),
      sync: new SyncManager(engine, () => name),
      put: (p: string, s: string) => adapter.writeBinary(p, enc(s)),
      get: async (p: string) => dec(await adapter.readBinary(p)),
    };
  };
  const a = mk(adapters.a, "a"), b = mk(adapters.b, "b");
  await a.ready; await b.ready;
  const out: Record<string, unknown> = { hasBuffer: typeof (globalThis as any).Buffer !== "undefined" };

  await a.adapter.mkdir("folder");
  await a.put("folder/note.md", "1\n2\n3\n4\n5\n");
  out.push = (await a.sync.sync()).kind;
  out.pull = (await b.sync.sync()).kind;
  out.propagated = await b.get("folder/note.md");

  await a.put("folder/note.md", "ONE\n2\n3\n4\n5\n");
  await b.put("folder/note.md", "1\n2\n3\n4\nFIVE\n");
  await a.sync.sync();
  out.merge = (await b.sync.sync()).kind;
  await a.sync.sync();
  out.merged = [await a.get("folder/note.md"), await b.get("folder/note.md")];

  await a.put("c.md", "base\n"); await a.sync.sync(); await b.sync.sync();
  await a.put("c.md", "from a\n"); await b.put("c.md", "from b\n");
  await a.sync.sync();
  const s = await b.sync.sync();
  out.conflict = s.kind;
  out.markers = (await b.get("c.md")).includes("<<<<<<<");
  await b.put("c.md", "resolved\n");
  out.resolve = (await b.sync.sync()).kind;
  await a.sync.sync();
  out.resolved = await a.get("c.md");
  return out;
}
