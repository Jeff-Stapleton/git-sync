import { mkdirSync, promises as fsp, statSync } from "fs";
import { join } from "path";
import type { MinimalAdapter } from "../../src/git/obsidianFs";

/** A DataAdapter look-alike over a real directory, as strict as Obsidian's (no implicit parent dirs). */
export function nodeAdapter(root: string): MinimalAdapter {
  const abs = (p: string) => join(root, p === "/" ? "" : p);
  return {
    async stat(p) {
      try {
        const s = statSync(abs(p));
        return { type: s.isDirectory() ? "folder" : "file", ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
    async list(p) {
      const entries = await fsp.readdir(abs(p), { withFileTypes: true });
      const prefix = p === "/" || p === "" ? "" : p + "/";
      return {
        files: entries.filter((e) => e.isFile()).map((e) => prefix + e.name),
        folders: entries.filter((e) => e.isDirectory()).map((e) => prefix + e.name),
      };
    },
    async readBinary(p) {
      const b = await fsp.readFile(abs(p));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    async writeBinary(p, data) {
      await fsp.writeFile(abs(p), Buffer.from(data)); // throws if parent is missing, like Obsidian
    },
    async mkdir(p) {
      mkdirSync(abs(p), { recursive: true });
    },
    async remove(p) {
      await fsp.unlink(abs(p));
    },
    async rmdir(p, recursive) {
      await fsp.rm(abs(p), { recursive, force: false });
    },
  };
}
