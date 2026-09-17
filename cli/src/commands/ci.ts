import { assertCiUsage, parseCiArgs } from "../ci/args";
import { formatCiOutcome, printCiLine } from "../ci/format";
import { collectCiSecrets } from "../ci/redact-log";
import { resolvePrompt, runCiTurn } from "../ci/run";
import { cwdPath } from "../workspace";

export type CiCommandDeps = {
  run: typeof runCiTurn;
  exit: (code: number) => void;
  readPrompt?: typeof resolvePrompt;
  write?: typeof printCiLine;
};

export async function ciCommandBody(
  argv: string[],
  deps: CiCommandDeps,
): Promise<void> {
  const parsed = parseCiArgs(argv);
  const prompt = await (deps.readPrompt ?? resolvePrompt)(parsed);
  assertCiUsage(parsed, prompt);

  const write = deps.write ?? printCiLine;
  write("stderr", `ci start cwd=${cwdPath()}`, collectCiSecrets());
  const { outcome, exitCode } = await deps.run({
    prompt,
    chatId: parsed.chatId,
    sessionId: parsed.sessionId,
    modeFlag: parsed.modeFlag,
    timeoutMs: parsed.timeoutMs,
  });
  const line = formatCiOutcome(outcome);
  write(line.stream, line.text);
  deps.exit(exitCode);
}

export async function ciCommand(argv: string[]): Promise<void> {
  await ciCommandBody(argv, {
    run: runCiTurn,
    exit: (code) => process.exit(code),
  });
}
