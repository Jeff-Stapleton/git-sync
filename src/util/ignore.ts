/** Lines every synced vault should ignore. The plugin's data.json holds the access token. */
export const DEFAULT_IGNORE_LINES = [
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/cache",
  ".obsidian/plugins/git-sync/data.json",
  ".trash/",
  ".DS_Store",
];

/** Returns new .gitignore content with any missing default lines appended, or null if unchanged. */
export function mergeGitignore(existing: string): string | null {
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = DEFAULT_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return null;
  const base = existing.length && !existing.endsWith("\n") ? existing + "\n" : existing;
  return base + missing.join("\n") + "\n";
}

/** True for vault-relative paths that should never trigger a sync. */
export function isIgnoredPath(path: string): boolean {
  const p = path.replace(/^\/+/, "");
  return (
    p === ".git" ||
    p.startsWith(".git/") ||
    p.startsWith(".trash/") ||
    /^\.obsidian\/workspace(-mobile)?\.json$/.test(p) ||
    p.startsWith(".obsidian/cache") ||
    p === ".obsidian/plugins/git-sync/data.json" ||
    p.endsWith(".DS_Store")
  );
}
