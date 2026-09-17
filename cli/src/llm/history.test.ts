import { describe, expect, test } from "bun:test";
import { historyFromChatMessages } from "./history";

describe("historyFromChatMessages attachments", () => {
  test("rehydrates snapshot, not a disk reread", () => {
    const hist = historyFromChatMessages(
      [
        {
          role: "user",
          content: "explica @src/auth.ts",
          metadata: {
            attachments: [
              {
                path: "src/auth.ts",
                kind: "text",
                status: "ok",
                hydratedText: "export const TOKEN = 'SNAP-1';",
              },
            ],
          },
        },
        { role: "assistant", content: "ok" },
        { role: "user", content: "¿cuál era el token del attach?" },
      ],
      "¿cuál era el token del attach?",
    );
    expect(hist[0]!.content).toMatch(/SNAP-1/);
    expect(hist[0]!.content).toMatch(/not re-read from disk/);
  });
});
