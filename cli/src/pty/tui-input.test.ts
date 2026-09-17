import { describe, expect, test } from "bun:test";
import { formatPtyHeader } from "./display";

describe("formatPtyHeader", () => {
  test("shows the PTY hostname and path", () => {
    expect(formatPtyHeader("box", "/repo")).toBe("pty · box · /repo");
  });
});
