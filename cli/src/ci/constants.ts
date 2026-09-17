/** keep-in-sync: api/src/ci/constants.ts */

import { QUEUE_CI_BUSY } from "../queue/constants";

export const ASK_CI_INVALID = "ask no válido en no-interactivo";
export const TUI_NO_TTY =
  'No TTY: TUI no se abre en no-interactivo. Usa: chavez ci --mode auto "<prompt>"';
export const NO_SECRET_PROMPT =
  "No se piden secrets por prompt en no-interactivo. Usa un vault ya linked o CHAVEZ_ACCESS_TOKEN.";
export const NO_LOGIN_PROMPT =
  "No hay sesión. En no-interactivo usa CHAVEZ_ACCESS_TOKEN (vault ya linked). No se pide login por prompt.";
export const NO_SESSION_CI = NO_LOGIN_PROMPT;
export const CI_OK_LINE = "ci ok";
export const CI_FAIL_PREFIX = "ci fail: ";
export const CI_TIMEOUT = "CI turn timed out";
export const CI_BUSY = QUEUE_CI_BUSY;
export const CI_SESSION_TITLE = "CI";
export const CI_TURN_TIMEOUT_MS = 600_000;
export const CI_TURN_TIMEOUT_MAX_MS = 1_800_000;
export const CI_EXIT_OK = 0;
export const CI_EXIT_FAIL = 1;
export const CI_EXIT_ASK = 2;
export const CI_SOURCE = "ci";
export const CI_HUB_HINT =
  'CI: CHAVEZ_ACCESS_TOKEN=… chavez ci --mode auto "<prompt>"  → exit 0/≠0, log texto. Sin GitHub Action.';
export const CI_USAGE =
  "Uso: chavez ci [--mode auto|plan] [--chat <chatId>] [--timeout <ms>] [--ci] <prompt…>";
