import { describe, expect, test } from "bun:test";
import {
  commandNeedsNetwork,
  toolNeedsNetwork,
} from "./network-classify";

describe("commandNeedsNetwork", () => {
  test("curl to internet", () => {
    expect(commandNeedsNetwork("curl https://example.com")).toBe(true);
    expect(commandNeedsNetwork("curl -s http://1.1.1.1")).toBe(true);
  });

  test("wget / nc / ssh", () => {
    expect(commandNeedsNetwork("wget https://x")).toBe(true);
    expect(commandNeedsNetwork("nc -zv example.com 443")).toBe(true);
    expect(commandNeedsNetwork("ssh git@github.com")).toBe(true);
  });

  test("git network vs local", () => {
    expect(commandNeedsNetwork("git push origin HEAD")).toBe(true);
    expect(commandNeedsNetwork("git fetch")).toBe(true);
    expect(commandNeedsNetwork("git pull")).toBe(true);
    expect(commandNeedsNetwork("git clone https://github.com/a/b")).toBe(true);
    expect(commandNeedsNetwork("git status")).toBe(false);
    expect(commandNeedsNetwork("git diff")).toBe(false);
    expect(commandNeedsNetwork("git commit -m ok")).toBe(false);
  });

  test("package install", () => {
    expect(commandNeedsNetwork("npm install")).toBe(true);
    expect(commandNeedsNetwork("pip install requests")).toBe(true);
    expect(commandNeedsNetwork("npm test")).toBe(false);
  });

  test("local bash does not need network", () => {
    expect(commandNeedsNetwork("ls")).toBe(false);
    expect(commandNeedsNetwork("echo hello")).toBe(false);
    expect(commandNeedsNetwork("python -m pytest")).toBe(false);
    expect(commandNeedsNetwork("cat src/index.ts")).toBe(false);
  });
});

describe("toolNeedsNetwork", () => {
  test("WebFetch always", () => {
    expect(toolNeedsNetwork("WebFetch", { url: "https://x" })).toBe(true);
    expect(toolNeedsNetwork("WebSearch", { query: "x" })).toBe(true);
    expect(toolNeedsNetwork("mcp__chavez-web__fetch", { url: "https://x" })).toBe(
      true,
    );
    expect(toolNeedsNetwork("web_fetch", { url: "https://x" })).toBe(true);
  });

  test("Bash delegates to command", () => {
    expect(toolNeedsNetwork("Bash", { command: "curl https://x" })).toBe(true);
    expect(toolNeedsNetwork("Bash", { command: "ls" })).toBe(false);
  });

  test("Read never", () => {
    expect(toolNeedsNetwork("Read", { file_path: "a.ts" })).toBe(false);
  });
});
