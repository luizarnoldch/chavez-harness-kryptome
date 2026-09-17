# Task 9 Report — Smoke Gherkin

## Done
- Created `cli/scripts/verify-loop-smoke.ts` covering all six Gherkin scenarios (no live LLM).
- Added `"test:verify"` script to `cli/package.json` (existing scripts preserved).

## Adaptation
- Scenario 1 bash command: `npm test` instead of `echo ok-tests` — `noteToolResult` only tracks verify/lint in-flight commands.

## Verification
- `bun run scripts/verify-loop-smoke.ts` → `verify-loop-smoke ok`, exit 0, ~1.7s (sleep 30 killed at 200ms).
- `bun test src/llm/verify-*.test.ts` → 38 pass, 0 fail.

## Commit
`test(verify): smoke the six Gherkin verification-loop scenarios`

## Final whole-branch review fixes
- Cursor shell aliases now pass through `gateVerifyBash`; headless ask mode denies with `ASK_DENIED`, and mutating plan verification reports `PLAN_VERIFY_MUTATION_DENIED`.
- Agent verification suppresses the configured pact only when it runs the same command.
- Failed verification with neutral or empty assistant text requests one bounded explanation; timeout remains excluded.

## Final verification
- `bun test src/llm/verify-turn.test.ts src/llm/verify-gate.test.ts src/llm/cursor-runner.test.ts` → 23 pass, 0 fail.
- `bun run scripts/verify-loop-smoke.ts` → `verify-loop-smoke ok`.
