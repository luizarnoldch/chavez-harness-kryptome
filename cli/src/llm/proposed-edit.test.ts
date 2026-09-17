import { describe, expect, test } from "bun:test";
import { proposedAfterSnapshot, toolPathFromInput } from "./proposed-edit";
import { emptySnapshot, textSnapshot } from "./unified-diff";

describe("toolPathFromInput", () => {
  test("file_path wins", () => {
    expect(toolPathFromInput({ file_path: "src/a.ts", path: "no" })).toBe("src/a.ts");
  });
});

describe("proposedAfterSnapshot", () => {
  test("Write creates from empty", () => {
    const after = proposedAfterSnapshot("Write", { content: "x\n" }, emptySnapshot());
    expect(after?.existed).toBe(true);
    expect(after?.text).toBe("x\n");
  });

  test("Edit replaces first occurrence", () => {
    const before = textSnapshot("foo bar foo");
    const after = proposedAfterSnapshot(
      "Edit",
      { old_string: "foo", new_string: "baz" },
      before,
    );
    expect(after?.text).toBe("baz bar foo");
  });

  test("Edit missing old_string → null", () => {
    expect(
      proposedAfterSnapshot("Edit", { old_string: "nope", new_string: "x" }, textSnapshot("abc")),
    ).toBeNull();
  });
});
