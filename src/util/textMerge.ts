import { diff3Merge } from "node-diff3";

export interface TextMergeResult {
  text: string;
  /** True if `text` contains conflict markers. */
  conflict: boolean;
}

const lines = (t: string) => (t.length ? t.split("\n") : []);
const stripNl = (t: string) => (t.endsWith("\n") ? t.slice(0, -1) : t);

/**
 * Line-based 3-way merge (like `git merge-file`). Non-overlapping edits merge cleanly;
 * overlapping ones get standard markers labelled "local" (this device) and "remote".
 */
export function mergeText(ours: string, base: string, theirs: string): TextMergeResult {
  const trailingNl = ours.endsWith("\n") || theirs.endsWith("\n");
  const regions = diff3Merge(lines(stripNl(ours)), lines(stripNl(base)), lines(stripNl(theirs)), {
    excludeFalseConflicts: true,
  });
  const out: string[] = [];
  let conflict = false;
  for (const r of regions) {
    if (r.ok) out.push(...r.ok);
    else if (r.conflict) {
      conflict = true;
      out.push("<<<<<<< local", ...r.conflict.a, "=======", ...r.conflict.b, ">>>>>>> remote");
    }
  }
  return { text: out.join("\n") + (trailingNl ? "\n" : ""), conflict };
}
