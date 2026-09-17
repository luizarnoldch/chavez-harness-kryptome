import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBashKind, promptAsksForTests } from "../src/llm/verify-classify";
import { extractVerifyCommandFromText, pactCommandFromRules } from "../src/llm/verify-pact";
import { gateVerifyBash } from "../src/llm/verify-gate";
import { runVerifyCommand } from "../src/llm/verify-run";
import {
  createTurnVerifyState,
  noteToolResult,
  noteToolStart,
  runPactIfNeeded,
  shouldExplain,
  shouldRunPact,
} from "../src/llm/verify-turn";
import { formatWatchLine } from "../src/llm/watch-format";
import { PLAN_VERIFY_MUTATION_DENIED, VERIFY_TIMEOUT_ERROR } from "../src/llm/verify-constants";
import { isSilentSuccess, verificationHeadline } from "../src/llm/verify-outcome";

const cwd = mkdtempSync(join(tmpdir(), "chavez-verify-smoke-"));
writeFileSync(join(cwd, "x.ts"), "export const x = 1;\n");

// Escenario: El usuario pide tests
assert.equal(promptAsksForTests("cambia X y corre los tests"), true);
assert.equal(classifyBashKind("npm test"), "verify");
{
  const s = createTurnVerifyState({
    mode: "auto",
    pactCommand: "echo ok-tests",
    prompt: "cambia X y corre los tests",
  });
  noteToolStart(s, { toolCallId: "w", sdkName: "Write" });
  noteToolStart(s, {
    toolCallId: "t",
    sdkName: "Bash",
    input: { command: "npm test" },
  });
  const meta = noteToolResult(s, {
    toolCallId: "t",
    sdkName: "Bash",
    output: "exit 1\nFAIL x.test.ts",
    status: "error",
  });
  assert.equal(meta?.status, "failed");
  assert.equal(isSilentSuccess("All tests passed. Done.", meta!), true);
  assert.equal(shouldExplain(s, "All tests passed. Done."), true);
  assert.equal(shouldExplain(s, "FAIL x.test.ts — missing export"), false);
}

// Escenario: Linter/diagnostics no sustituyen al diff
{
  const lint = formatWatchLine({
    type: "chat.tool.result",
    data: {
      metadata: {
        kind: "lint",
        command: "tsc --noEmit",
        status: "done",
        output: "x.ts(1,1): error TS1234",
      },
    },
  });
  const diff = formatWatchLine({
    type: "chat.diff.upsert",
    data: { diff: { path: "x.ts", kind: "modified", additions: 1, deletions: 0 } },
  });
  assert.match(String(lint), /^lint ·/);
  // diff line may be null if plan 6 formatter is absent — then at least lint is not a diff
  if (diff) assert.match(diff, /^diff ·/);
  assert.notEqual(lint, diff);
}

// Escenario: Modo plan no corre tests que mutan
{
  const g = gateVerifyBash({
    mode: "plan",
    sdkName: "Bash",
    toolInput: { command: "npx jest --coverage --updateSnapshot" },
  });
  assert.equal(g.decision, "deny");
  assert.equal(g.message, PLAN_VERIFY_MUTATION_DENIED);
  const plain = gateVerifyBash({
    mode: "plan",
    sdkName: "Bash",
    toolInput: { command: "npm test" },
  });
  assert.equal(plain.decision, "deny");
}

// Escenario: Modo ask — test no es skip-as-read
{
  const g = gateVerifyBash({
    mode: "ask",
    sdkName: "Bash",
    toolInput: { command: "bun test" },
  });
  assert.equal(g.decision, "ask");
  const readish = gateVerifyBash({
    mode: "ask",
    sdkName: "Read",
    toolInput: { file_path: "x.ts" },
  });
  assert.equal(readish.decision, "passthrough");
}

// Escenario: Verificación pactada / no inventar
{
  const pact = extractVerifyCommandFromText(`---
verify: npm test
---
# AGENTS
`);
  assert.equal(pact, "npm test");
  assert.equal(pactCommandFromRules([]), null);
  assert.equal(
    pactCommandFromRules([{ layer: "project", body: "Be nice." }]),
    null,
  );
  const s = createTurnVerifyState({
    mode: "auto",
    pactCommand: "echo pact-ok",
    prompt: "cambia X",
  });
  noteToolStart(s, { toolCallId: "w", sdkName: "Edit" });
  assert.equal(shouldRunPact(s), true);
  const ran = await runPactIfNeeded(s, cwd);
  assert.equal(ran.ran, true);
  assert.equal(ran.result?.ok, true);

  const none = createTurnVerifyState({
    mode: "auto",
    pactCommand: null,
    prompt: "cambia X",
  });
  noteToolStart(none, { toolCallId: "w", sdkName: "Write" });
  const skipped = await runPactIfNeeded(none, cwd);
  assert.equal(skipped.ran, false);
  assert.match(String(skipped.skipReason), /not inventing a test suite/);
}

// Escenario: Test interminable → timeout, tool error, turn cierra
{
  const r = await runVerifyCommand({
    cwd,
    command: "sleep 30",
    timeoutMs: 200,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 124);
  const line = formatWatchLine({
    type: "chat.stream.error",
    data: { error: VERIFY_TIMEOUT_ERROR },
  });
  assert.match(String(line), /timeout/);
  assert.equal(verificationHeadline({
    status: "timeout",
    kind: "verify",
    command: "sleep 30",
    exitCode: 124,
    timedOut: true,
    source: "agent",
    truncated: false,
  }).includes("timeout"), true);
}

console.log("verify-loop-smoke ok");
