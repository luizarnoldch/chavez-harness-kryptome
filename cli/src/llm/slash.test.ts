import { describe, expect, test } from "bun:test";
import {
  SLASH_PICKER_LIMIT,
  UNKNOWN_SLASH,
  activeSlash,
  composerTrigger,
  formatHelp,
  HELP_MODES,
  isSlashInput,
  parseSlash,
  slashPickerItems,
} from "./slash";

describe("isSlashInput / parseSlash", () => {
  test("plain prompt is not slash", () => {
    expect(isSlashInput("arregla el test")).toBe(false);
    expect(parseSlash("arregla el test").ok).toBe(false);
    if (!parseSlash("arregla el test").ok) {
      expect(parseSlash("arregla el test").error).toBe("not_slash");
    }
  });

  test("src/lib is not slash", () => {
    expect(isSlashInput("src/lib")).toBe(false);
    expect(parseSlash("cd src/lib").ok).toBe(false);
  });

  test("/mode auto", () => {
    const p = parseSlash("  /mode auto  ");
    expect(p).toEqual({
      ok: true,
      command: "mode",
      args: ["auto"],
      raw: "/mode auto",
    });
  });

  test("/plan is alias command, not mode arg", () => {
    const p = parseSlash("/plan");
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.command).toBe("plan");
  });

  test("unknown explains /help", () => {
    const p = parseSlash("/foo");
    expect(p.ok).toBe(false);
    if (!p.ok && p.error === "unknown") {
      expect(p.name).toBe("foo");
    }
    expect(UNKNOWN_SLASH).toContain("/help");
  });

  test("lone slash is help", () => {
    const p = parseSlash("/");
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.command).toBe("help");
  });
});

describe("composerTrigger: / vs @", () => {
  test("typing / is slash, not mention", () => {
    const t = composerTrigger("/");
    expect(t?.kind).toBe("slash");
    expect(t && t.kind === "slash" ? t.query : null).toBe("");
  });

  test("@src does not open slash", () => {
    const t = composerTrigger("@src");
    expect(t?.kind).toBe("mention");
  });

  test("slash wins over an earlier @", () => {
    const text = "@src/auth.ts /mod";
    const t = composerTrigger(text);
    expect(t?.kind).toBe("slash");
    expect(t && t.kind === "slash" ? t.query : null).toBe("mod");
  });

  test("mention wins over an earlier / in another token", () => {
    const text = "/mode @src";
    const t = composerTrigger(text);
    expect(t?.kind).toBe("mention");
  });

  test("user@host is not mention nor slash", () => {
    expect(composerTrigger("user@host")).toBeNull();
    expect(activeSlash("user@host")).toBeNull();
  });
});

describe("slashPickerItems", () => {
  test("/ lists commands, not files, max 10", () => {
    const items = slashPickerItems("");
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(SLASH_PICKER_LIMIT);
    expect(items.every((i) => i.insert.startsWith("/"))).toBe(true);
    expect(items.some((i) => i.insert.includes("src/"))).toBe(false);
  });

  test("prefix /c refines to compact/clear/cost", () => {
    const ids = slashPickerItems("c").map((i) => i.id).sort();
    expect(ids).toEqual(["clear", "compact", "cost"]);
  });

  test("/mode args", () => {
    const ids = slashPickerItems("mode a").map((i) => i.id);
    expect(ids).toContain("mode:ask");
    expect(ids).toContain("mode:auto");
    expect(ids).not.toContain("mode:plan");
  });

  test("/model caps at 10 and refines", () => {
    const modelIds = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const items = slashPickerItems("model m1", { modelIds });
    expect(items.length).toBeLessThanOrEqual(10);
    expect(items.every((i) => i.insert.startsWith("/model m1"))).toBe(true);
  });

  test("picking /help executes; /mode inserts trailing space", () => {
    const help = slashPickerItems("hel").find((i) => i.id === "help");
    expect(help?.executeOnPick).toBe(true);
    expect(help?.insert).toBe("/help");
    const mode = slashPickerItems("mod").find((i) => i.id === "mode");
    expect(mode?.executeOnPick).toBe(false);
    expect(mode?.insert).toBe("/mode ");
  });
});

describe("formatHelp", () => {
  test("lists commands and modes", () => {
    const h = formatHelp();
    expect(h).toContain("/mode");
    expect(h).toContain("/compact");
    expect(h).toContain("/undo");
    expect(h).toContain("/cost");
    expect(h).toContain("/help");
    expect(h).toContain(HELP_MODES);
  });
});
