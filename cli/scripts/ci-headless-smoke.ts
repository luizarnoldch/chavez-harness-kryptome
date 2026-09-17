/**
 * Live smoke for plan 25. Needs API + CHAVEZ_ACCESS_TOKEN (or ~/.chavez/config.json).
 * Does NOT call the LLM if --dry. Default: --dry (guards + mode + redact).
 * Pass --live to run one auto turn against the cwd (requires linked Claude).
 */
import { ASK_CI_INVALID, TUI_NO_TTY, NO_SECRET_PROMPT } from "../src/ci/constants";
import { isTuiForbidden } from "../src/ci/detect";
import { resolveCiMode } from "../src/ci/args";
import { redactCiLog } from "../src/ci/redact-log";
import { runCiTurn } from "../src/ci/run";
import { loadConfig } from "../src/config";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(isTuiForbidden({ CI: "true" }, { isTTY: true }, { isTTY: true }), "CI forbids TUI");
assert(resolveCiMode({ flag: "ask" }).ok === false, "ask flag rejected");
const ask = resolveCiMode({ flag: "ask" });
assert(!ask.ok && ask.error === ASK_CI_INVALID, ASK_CI_INVALID);
assert(
  redactCiLog("sk-ant-api03-aaaa").includes("***") ||
    !redactCiLog("sk-ant-api03-aaaa").includes("sk-ant-"),
  "keys redacted",
);
console.log("A) dry guards ok", TUI_NO_TTY.slice(0, 7), NO_SECRET_PROMPT.slice(0, 7));

const live = process.argv.includes("--live");
if (!live) {
  console.log("ci-headless-smoke dry ok");
  process.exit(0);
}

const token = process.env.CHAVEZ_ACCESS_TOKEN || loadConfig().accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const { exitCode, outcome } = await runCiTurn({
  prompt: "Reply with exactly: pong",
  modeFlag: "auto",
  timeoutMs: 120_000,
});
if (exitCode !== 0) {
  throw new Error(
    `live ci expected 0, got ${exitCode} verification=${outcome.verificationStatus} error=${outcome.streamError ?? outcome.providerError ?? ""}`,
  );
}
console.log("B) live auto turn ok");
console.log("ci-headless-smoke live ok");
