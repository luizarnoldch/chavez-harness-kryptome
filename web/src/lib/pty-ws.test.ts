import { describe, expect, test } from "bun:test";
import {
  decodePtyChunk,
  encodePtyChunk,
  formatPtyHeader,
} from "./pty-ws";

describe("pty websocket helpers", () => {
  test("formats the daemon hostname and cwd", () => {
    expect(formatPtyHeader("devbox", "/repo")).toBe("pty · devbox · /repo");
  });

  test("round-trips unicode terminal data as base64", () => {
    const chunk = "hola λ 🚀\r\n";
    expect(decodePtyChunk(encodePtyChunk(chunk))).toBe(chunk);
  });

  test("decodes legacy binary base64 when UTF-8 decoding fails", () => {
    expect(decodePtyChunk("/w==")).toBe("ÿ");
  });
});
