/** True if the text still contains a git conflict block (opening and closing marker lines). */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}( .*)?$/m.test(text) && /^>{7}( .*)?$/m.test(text);
}

/** Git's own heuristic: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** "a/b/photo.png" -> "a/b/photo.conflict-remote-20260928T220000.png" */
export function conflictCopyPath(path: string, label: string, stamp: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const hasExt = dot > slash + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  return `${stem}.conflict-${label}-${stamp}${ext}`;
}
