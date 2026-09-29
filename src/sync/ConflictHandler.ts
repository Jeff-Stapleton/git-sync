import type { GitEngine } from "../git/GitEngine";
import { conflictCopyPath, hasConflictMarkers } from "../util/markers";

export interface AutoResolveResult {
  /** Text conflicts left for the user, with markers in the working tree. */
  remaining: string[];
  /** Human-readable notes about what was resolved automatically. */
  notes: string[];
}

const stampOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").slice(0, 15);

/**
 * Policy for conflicts that can't or shouldn't be left as text markers:
 *  - .obsidian/ config: remote wins (latest pushed settings).
 *  - delete vs modify: keep the modified file, nothing is lost.
 *  - binary on both sides: keep local in place, save the remote version as a conflict copy.
 * Everything else (text edited on both sides) is left with standard markers.
 */
export async function autoResolve(engine: GitEngine, now = new Date()): Promise<AutoResolveResult> {
  const remaining: string[] = [];
  const notes: string[] = [];
  for (const c of await engine.conflicts()) {
    if (c.path.startsWith(".obsidian/")) {
      await engine.takeSide(c.path, "theirs");
      notes.push(`${c.path}: took remote settings`);
    } else if (c.kind === "deleted-by-us") {
      await engine.takeSide(c.path, "theirs");
      notes.push(`${c.path}: deleted here but edited elsewhere — kept the edited file`);
    } else if (c.kind === "deleted-by-them") {
      await engine.takeSide(c.path, "ours");
      notes.push(`${c.path}: edited here but deleted elsewhere — kept the edited file`);
    } else if (c.binary) {
      const theirs = await engine.readSide(c.path, "theirs");
      await engine.takeSide(c.path, "ours");
      if (theirs) {
        const copy = conflictCopyPath(c.path, "remote", stampOf(now));
        await engine.writeWorkFile(copy, theirs);
        await engine.stageResolved(copy);
        notes.push(`${c.path}: binary conflict — kept yours, remote version saved as ${copy}`);
      }
    } else {
      remaining.push(c.path);
    }
  }
  return { remaining, notes };
}

/**
 * After the user edits conflicted files by hand: stage each one whose markers
 * are gone (or that was deleted). Returns the paths still unresolved.
 */
export async function stageHandResolved(engine: GitEngine): Promise<string[]> {
  const still: string[] = [];
  for (const c of await engine.conflicts()) {
    const data = await engine.readWorkFile(c.path);
    if (data === null || !hasConflictMarkers(new TextDecoder().decode(data))) {
      await engine.stageResolved(c.path);
    } else {
      still.push(c.path);
    }
  }
  return still;
}
