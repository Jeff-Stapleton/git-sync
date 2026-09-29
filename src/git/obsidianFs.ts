/** The slice of Obsidian's DataAdapter that git needs (also implementable over Node fs in tests). */
export interface MinimalAdapter {
  stat(path: string): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

function fsError(code: string, path: string): Error {
  const e = new Error(`${code}: ${path}`) as Error & { code: string };
  e.code = code;
  return e;
}

/** "/a//b/" -> "a/b"; root -> "". */
const norm = (p: string) => p.split("/").filter(Boolean).join("/");
const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

class Stats {
  readonly dev = 0;
  readonly ino = 0;
  readonly uid = 0;
  readonly gid = 0;
  readonly mode: number;
  readonly ctimeMs: number;
  readonly mtimeMs: number;
  readonly size: number;
  constructor(private isDir: boolean, s: { ctime: number; mtime: number; size: number }) {
    this.mode = isDir ? 0o040000 : 0o100644;
    this.ctimeMs = s.ctime || s.mtime;
    this.mtimeMs = s.mtime;
    this.size = isDir ? 0 : s.size;
  }
  isFile() { return !this.isDir; }
  isDirectory() { return this.isDir; }
  isSymbolicLink() { return false; }
}

/**
 * isomorphic-git `fs` over an Obsidian DataAdapter. Paths are vault-relative; the leading "/"
 * isomorphic-git uses for `dir: "/"` is stripped. No symlinks (mobile has none).
 */
export function createObsidianFs(adapter: MinimalAdapter) {
  const stat = async (path: string) => {
    const p = norm(path);
    if (p === "") return new Stats(true, { ctime: 0, mtime: 0, size: 0 });
    const s = await adapter.stat(p);
    if (!s) throw fsError("ENOENT", path);
    return new Stats(s.type === "folder", s);
  };

  const promises = {
    async readFile(path: string, opts?: string | { encoding?: string }) {
      const p = norm(path);
      const s = await adapter.stat(p);
      if (!s) throw fsError("ENOENT", path);
      if (s.type === "folder") throw fsError("EISDIR", path);
      const bytes = new Uint8Array(await adapter.readBinary(p));
      const enc = typeof opts === "string" ? opts : opts?.encoding;
      return enc ? new TextDecoder().decode(bytes) : bytes;
    },
    async writeFile(path: string, data: string | Uint8Array) {
      const p = norm(path);
      const parent = parentOf(p);
      if (parent && !(await adapter.stat(parent))) throw fsError("ENOENT", path);
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await adapter.writeBinary(p, ab);
    },
    async unlink(path: string) {
      const p = norm(path);
      if (!(await adapter.stat(p))) throw fsError("ENOENT", path);
      await adapter.remove(p);
    },
    async readdir(path: string) {
      const p = norm(path);
      const s = p === "" ? { type: "folder" } : await adapter.stat(p);
      if (!s) throw fsError("ENOENT", path);
      if (s.type !== "folder") throw fsError("ENOTDIR", path);
      const listed = await adapter.list(p === "" ? "/" : p);
      return [...listed.files, ...listed.folders].map((f) => f.slice(f.lastIndexOf("/") + 1));
    },
    async mkdir(path: string) {
      const p = norm(path);
      if (await adapter.stat(p)) throw fsError("EEXIST", path);
      await adapter.mkdir(p);
    },
    async rmdir(path: string) {
      await adapter.rmdir(norm(path), false);
    },
    stat,
    lstat: stat,
    // isomorphic-git binds these unconditionally; there are no symlinks in a vault.
    async readlink(path: string): Promise<string> {
      throw fsError("EINVAL", path);
    },
    async symlink(_target: string, path: string): Promise<void> {
      throw fsError("EPERM", path);
    },
  };
  return { promises };
}
