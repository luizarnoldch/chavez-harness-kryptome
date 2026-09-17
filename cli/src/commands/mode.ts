import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import {
  INVALID_MODE_ERROR,
  parseExecutionMode,
  type ExecutionMode,
} from "../llm/execution-mode";

function requireAuth(): void {
  if (!loadConfig().accessToken) {
    throw new Error("No hay sesión. Ejecuta: chavez login");
  }
}

type Prefs = {
  activeExecutionMode?: string | null;
  activeProvider?: string | null;
};

export async function modeCommand(args: string[]): Promise<void> {
  requireAuth();
  const raw = args[0];
  if (!raw) {
    const data = await apiFetch<Prefs>("/providers");
    const mode = parseExecutionMode(data.activeExecutionMode);
    console.log(`Mode: ${mode}`);
    return;
  }
  if (raw === "-h" || raw === "--help") {
    console.log("Uso: chavez mode [plan|auto|ask]");
    return;
  }
  let mode: ExecutionMode;
  try {
    mode = parseExecutionMode(raw, { defaultOnEmpty: false });
  } catch {
    throw new Error(INVALID_MODE_ERROR);
  }
  const data = await apiFetch<Prefs>("/providers/preferences", {
    method: "PUT",
    body: JSON.stringify({ activeExecutionMode: mode }),
  });
  console.log(`Mode: ${parseExecutionMode(data.activeExecutionMode)}`);
}
