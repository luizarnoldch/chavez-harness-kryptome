import { ASK_CI_INVALID, CI_EXIT_ASK, CI_EXIT_FAIL } from "./constants";

export class CiCliError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2 = CI_EXIT_FAIL) {
    super(message);
    this.name = "CiCliError";
    this.exitCode = exitCode;
  }
}

export function askCiError(): CiCliError {
  return new CiCliError(ASK_CI_INVALID, CI_EXIT_ASK);
}
