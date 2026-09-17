import { takeFlag } from "../llm/slash-flags";
import { capWaitTimeout } from "./admission";

export type ParsedAskArgs = {
  chatId: string;
  prompt: string;
  noQueue: boolean;
  waitTimeoutMs: number | undefined;
  mode?: string;
  provider?: string;
  model?: string;
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
  let filtered = positional;
  const mode = takeFlag(filtered, "--mode");
  filtered = mode.rest;
  const provider = takeFlag(filtered, "--provider");
  filtered = provider.rest;
  const model = takeFlag(filtered, "--model");
  filtered = model.rest;
  const chatId = filtered[0] || "";
  const prompt = filtered.slice(1).join(" ");
  return {
    chatId,
    prompt,
    noQueue,
    waitTimeoutMs,
    mode: mode.value,
    provider: provider.value,
    model: model.value,
  };
}
