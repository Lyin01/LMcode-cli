import { describe, expect, it } from "vitest";

import { lmPathLookupCommand } from "#/cli/lm-path";

// Locks in the cross-platform PATH-lookup command. A past divergence ran the
// POSIX form on Windows (no `which`, no /dev/null), silently skipping PATH
// resolution — this guards against that regressing again.
describe("lmPathLookupCommand", () => {
  it("uses `where` on Windows (cmd.exe has no `which`/`/dev/null`)", () => {
    expect(lmPathLookupCommand("win32")).toBe("where lm");
  });

  it("uses `which ... 2>/dev/null` on POSIX platforms", () => {
    expect(lmPathLookupCommand("linux")).toBe("which lm 2>/dev/null");
    expect(lmPathLookupCommand("darwin")).toBe("which lm 2>/dev/null");
  });
});
