import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import {
  PROMPT_GET_USAGE,
  PROMPT_LIST_USAGE,
  PROMPT_RM_USAGE,
  PROMPT_SAVE_USAGE,
  parseSavePromptInput,
  type SavedPrompt,
} from "../llm/prompt-library";

function token(): string {
  const t = loadConfig().accessToken;
  if (!t) throw new Error("No hay sesión. Ejecuta: chavez login");
  return t;
}

export async function promptCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action || action === "list") {
    const json = rest.includes("--json");
    const data = await apiFetch<{ prompts: SavedPrompt[] }>(
      "/prompts",
      {},
      token(),
    );
    const prompts = data.prompts ?? [];
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (!prompts.length) {
      console.log("0 prompts");
      return;
    }
    for (const p of prompts) {
      console.log(`${p.name}\t${p.title}`);
    }
    return;
  }
  if (action === "save") {
    const name = rest[0];
    const bodyArg = rest.slice(1).join(" ").trim();
    if (!name) throw new Error(PROMPT_SAVE_USAGE);
    const body = bodyArg || (await Bun.stdin.text()).trim();
    const input = parseSavePromptInput({ name, body });
    const data = await apiFetch(
      "/prompts",
      { method: "POST", body: JSON.stringify(input) },
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "get") {
    const name = rest[0];
    if (!name) throw new Error(PROMPT_GET_USAGE);
    const data = await apiFetch<{ prompt: SavedPrompt }>(
      `/prompts/${encodeURIComponent(name)}`,
      {},
      token(),
    );
    console.log(data.prompt.body);
    return;
  }
  if (action === "rm") {
    const name = rest[0];
    if (!name) throw new Error(PROMPT_RM_USAGE);
    const data = await apiFetch(
      `/prompts/${encodeURIComponent(name)}`,
      { method: "DELETE" },
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  throw new Error(
    `${PROMPT_LIST_USAGE}\n${PROMPT_SAVE_USAGE}\n${PROMPT_GET_USAGE}\n${PROMPT_RM_USAGE}`,
  );
}
