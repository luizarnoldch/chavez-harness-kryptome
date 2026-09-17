import { describe, expect, test } from "bun:test";
import { pushToCiEvent } from "./events";

describe("pushToCiEvent", () => {
  test("stream end sin verification", () => {
    expect(
      pushToCiEvent({ type: "chat.stream.end", data: { content: "done" } }),
    ).toEqual({
      kind: "stream_end",
      content: "done",
      verificationStatus: null,
    });
  });

  test("lee verification desde data", () => {
    expect(
      pushToCiEvent({
        type: "chat.stream.end",
        data: { verification: { status: "failed" } },
      }),
    ).toMatchObject({ verificationStatus: "failed" });
  });

  test("lee verification desde metadata del mensaje", () => {
    expect(
      pushToCiEvent({
        type: "chat.stream.end",
        data: {
          message: {
            metadata: { verification: { status: "timeout" } },
          },
        },
      }),
    ).toMatchObject({ verificationStatus: "timeout" });
  });

  test("convierte stream error", () => {
    expect(
      pushToCiEvent({
        type: "chat.stream.error",
        data: { content: "boom" },
      }),
    ).toEqual({ kind: "stream_error", error: "boom" });
  });

  test("convierte inicio de tool", () => {
    expect(
      pushToCiEvent({
        type: "chat.tool.start",
        data: { toolName: "bash" },
      }),
    ).toMatchObject({ kind: "tool", name: "bash", status: "running" });
  });

  test("ignora tipos desconocidos", () => {
    expect(pushToCiEvent({ type: "unknown" })).toBeNull();
  });
});
