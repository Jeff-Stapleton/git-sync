import { describe, expect, it } from "vitest";
import { mergeText } from "../src/util/textMerge";
import { hasConflictMarkers } from "../src/util/markers";

describe("mergeText", () => {
  it("merges edits to different parts of a note", () => {
    const r = mergeText("A\nb\nc\nd\n", "a\nb\nc\nd\n", "a\nb\nc\nD\n");
    expect(r).toEqual({ text: "A\nb\nc\nD\n", conflict: false });
  });
  it("marks overlapping edits", () => {
    const r = mergeText("l1\nours\nl3\n", "l1\nbase\nl3\n", "l1\ntheirs\nl3\n");
    expect(r.conflict).toBe(true);
    expect(r.text).toBe("l1\n<<<<<<< local\nours\n=======\ntheirs\n>>>>>>> remote\nl3\n");
    expect(hasConflictMarkers(r.text)).toBe(true);
  });
  it("treats identical edits as no conflict", () => {
    expect(mergeText("x\n", "y\n", "x\n")).toEqual({ text: "x\n", conflict: false });
  });
  it("handles both-added (empty base) and files without trailing newline", () => {
    expect(mergeText("a", "", "b").conflict).toBe(true);
    expect(mergeText("a\nb", "a\nb", "a\nB")).toEqual({ text: "a\nB", conflict: false });
  });
  it("handles empty sides", () => {
    expect(mergeText("", "", "new\n")).toEqual({ text: "new\n", conflict: false });
  });
});
