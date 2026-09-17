export { isNonInteractive } from "../queue/admission";

import { isNonInteractive } from "../queue/admission";

export function isSecretPromptForbidden(
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  if (isNonInteractive(env, stdout)) return true;
  return stdin.isTTY === false;
}

export function isTuiForbidden(
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  if (isNonInteractive(env, stdout)) return true;
  return stdin.isTTY === false || stdout.isTTY === false;
}
