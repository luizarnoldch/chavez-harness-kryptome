import { describe, expect, test } from "bun:test";
import { mergeMentions, parseMentions } from "./mentions";

describe("parseMentions", () => {
  test("picker and hand-typed paths", () => {
    const p = parseMentions("see @src/auth.ts and @package.json please");
    expect(p.map((x) => x.path)).toEqual(["src/auth.ts", "package.json"]);
  });

  test("quoted path", () => {
    expect(parseMentions('look @"foo bar.ts"').map((x) => x.path)).toEqual([
      "foo bar.ts",
    ]);
  });

  test("directory with trailing slash", () => {
    expect(parseMentions("list @src/").map((x) => x.path)).toEqual(["src"]);
  });

  test("email is not an attach", () => {
    expect(parseMentions("mail user@example.com thanks")).toEqual([]);
  });

  test("decorator is not an attach", () => {
    expect(parseMentions("use @override on the method")).toEqual([]);
  });

  test("multiple distinct mentions", () => {
    const p = parseMentions("@README.md then @src/index.ts");
    expect(p.map((x) => x.path)).toEqual(["README.md", "src/index.ts"]);
  });

  test("captures traversal so sandbox can reject it", () => {
    expect(parseMentions("x @../../.ssh/id_rsa").map((x) => x.path)).toEqual([
      "../../.ssh/id_rsa",
    ]);
  });

  test("captures absolute path so sandbox can reject it", () => {
    expect(parseMentions("x @/etc/passwd").map((x) => x.path)).toEqual([
      "/etc/passwd",
    ]);
  });
});

describe("mergeMentions", () => {
  test("unions picker extras with text", () => {
    expect(mergeMentions("see @a.ts", ["src", "@a.ts"])).toEqual(["a.ts", "src"]);
  });
});
