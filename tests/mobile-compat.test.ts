import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createContext, runInContext } from "vm";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { sharedOptions } from "../esbuild.shared.mjs";
import { startRemote } from "./helpers/gitHttpServer";
import { nodeAdapter } from "./helpers/nodeAdapter";

const root = resolve(__dirname, "..");
const bundleTo = async (entry: string, outfile: string) =>
  build({ ...sharedOptions, entryPoints: [join(root, entry)], outfile, absWorkingDir: root, logLevel: "silent" });

describe("mobile compatibility of the shipped bundle", () => {
  it("loads with no Node builtins, no Buffer and no process (what mobile Obsidian gives us)", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "bundle-")), "main.js");
    await bundleTo("src/main.ts", out);
    const code = readFileSync(out, "utf8");

    class Stub { constructor(..._a: unknown[]) {} }
    const obsidian = {
      Plugin: Stub, PluginSettingTab: Stub, Modal: Stub, Setting: Stub, Notice: Stub, TFile: Stub, FileSystemAdapter: Stub,
      Platform: { isMobile: true, isDesktopApp: false }, requestUrl: () => {},
    };
    const required: string[] = [];
    const sandbox: Record<string, unknown> = {
      module: { exports: {} }, exports: {},
      require: (name: string) => {
        required.push(name);
        if (name === "obsidian") return obsidian;
        throw new Error(`Cannot find module '${name}' (not available on mobile)`);
      },
      console, TextEncoder, TextDecoder, setTimeout, clearTimeout, atob, btoa, URL, crypto: globalThis.crypto, queueMicrotask,
    };
    createContext(sandbox);
    runInContext(code, sandbox as object);
    expect(typeof (sandbox.module as any).exports.default).toBe("function");
    // Loading must touch nothing but obsidian; Node-only modules (the CLI engine) load lazily on desktop.
    expect(required.length).toBeGreaterThan(0);
    expect(new Set(required)).toEqual(new Set(["obsidian"]));
  });

  it("runs a full two-device sync (merge + conflict) inside a sandbox with no Buffer, process or require", async () => {
    const remote = await startRemote();
    try {
      const dir = mkdtempSync(join(tmpdir(), "smoke-"));
      const out = join(dir, "smoke.cjs");
      await bundleTo("tests/smoke/entry.ts", out);
      const [a, b] = [join(dir, "a"), join(dir, "b")];
      for (const d of [a, b]) mkdirSync(d);

      // Only web-standard globals: what a phone's webview gives a plugin.
      const sandbox: Record<string, unknown> = {
        module: { exports: {} }, exports: {},
        console, TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
        atob, btoa, URL, URLSearchParams, AbortController, performance, crypto: globalThis.crypto,
      };
      createContext(sandbox);
      runInContext(readFileSync(out, "utf8"), sandbox as object);
      const requestUrl = async (p: any) => {
        const r = await fetch(p.url, { method: p.method, headers: p.headers, body: p.body ? Buffer.from(p.body) : undefined });
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => (headers[k] = v));
        return { status: r.status, headers, arrayBuffer: await r.arrayBuffer() };
      };
      const result = await (sandbox.module as any).exports.run({ a: nodeAdapter(a), b: nodeAdapter(b) }, requestUrl, remote.url, remote.token);
      expect(JSON.parse(JSON.stringify(result))).toEqual({
        hasBuffer: false,
        push: "idle", pull: "idle", propagated: "1\n2\n3\n4\n5\n",
        merge: "idle", merged: ["ONE\n2\n3\n4\nFIVE\n", "ONE\n2\n3\n4\nFIVE\n"],
        conflict: "conflict", markers: true, resolve: "idle", resolved: "resolved\n",
      });
    } finally {
      await remote.close();
    }
  }, 60_000);
});
