import { describe, expect, it } from "vitest";
import { conflictCopyPath, hasConflictMarkers, isBinary } from "../src/util/markers";

describe("markers", () => {
  it("detects an unresolved block, not a resolved file", () => {
    expect(hasConflictMarkers("a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> origin/main\nb")).toBe(true);
    expect(hasConflictMarkers("a\nx\nb")).toBe(false);
    expect(hasConflictMarkers("code: a <<<<<<< b")).toBe(false); // not at line start
    expect(hasConflictMarkers("<<<<<<< HEAD\nhalf-resolved\n")).toBe(false); // markers being edited out
  });
  it("detects binary by NUL byte", () => {
    expect(isBinary(new Uint8Array([104, 105]))).toBe(false);
    expect(isBinary(new Uint8Array([137, 80, 0, 1]))).toBe(true);
  });
  it("builds conflict copy names", () => {
    expect(conflictCopyPath("a/b/photo.png", "remote", "T1")).toBe("a/b/photo.conflict-remote-T1.png");
    expect(conflictCopyPath("README", "remote", "T1")).toBe("README.conflict-remote-T1");
    expect(conflictCopyPath("dir.d/file", "remote", "T1")).toBe("dir.d/file.conflict-remote-T1");
  });
});
