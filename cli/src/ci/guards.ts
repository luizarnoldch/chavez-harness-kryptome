import {
  NO_LOGIN_PROMPT,
  NO_SECRET_PROMPT,
  TUI_NO_TTY,
} from "./constants";
import {
  isNonInteractive,
  isSecretPromptForbidden,
  isTuiForbidden,
} from "./detect";
import { CiCliError } from "./errors";

export function assertCanOpenTui(
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): void {
  if (isTuiForbidden(env, stdin, stdout)) {
    throw new CiCliError(TUI_NO_TTY, 1);
  }
}

export function assertCanPromptSecret(
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): void {
  if (isSecretPromptForbidden(env, stdin, stdout)) {
    throw new CiCliError(NO_SECRET_PROMPT, 1);
  }
}

export function assertCanLoginInteractive(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean } = process.stdout,
): void {
  if (isNonInteractive(env, stdout)) {
    throw new CiCliError(NO_LOGIN_PROMPT, 1);
  }
}
