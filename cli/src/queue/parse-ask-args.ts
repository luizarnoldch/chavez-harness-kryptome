import { capWaitTimeout } from "./admission";

export type ParsedAskArgs = {
  chatId: string;
  prompt: string;
  noQueue: boolean;
  waitTimeoutMs: number | undefined;
};

export function parseAskArgs(rest: string[]): ParsedAskArgs {
  let noQueue = false;
  let waitTimeoutMs: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--no-queue") {
      noQueue = true;
      continue;
    }
    if (a === "--wait-timeout") {
      waitTimeoutMs = capWaitTimeout(Number(rest[++i]));
      continue;
    }
    if (a.startsWith("--wait-timeout=")) {
      waitTimeoutMs = capWaitTimeout(
        Number(a.slice("--wait-timeout=".length)),
      );
      continue;
    }
    positional.push(a);
  }
  const chatId = positional[0] || "";
  const prompt = positional.slice(1).join(" ");
  return { chatId, prompt, noQueue, waitTimeoutMs };
}
