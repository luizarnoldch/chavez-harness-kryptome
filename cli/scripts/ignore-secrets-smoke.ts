#!/usr/bin/env bun
/**
 * Smoke Plan 8 — ignore / secrets. No LLM.
 * Usage: bun run scripts/ignore-secrets-smoke.ts
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeWorkspace } from "../src/llm/fs-complete";
import { hydrateOne } from "../src/llm/hydrate-attachments";
import { decideAttach, hydrateForced } from "../src/llm/attach-force";
import { denyIfIgnored, filterGrepOrGlobOutput } from "../src/llm/tool-ignore";
import { listWorkspaceDir } from "../src/llm/fs-tree";
import { gitCommitBlockedReason } from "../src/llm/git-secret-guard";
import { redactDiffForCwd } from "../src/llm/secret-diff";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-p8-")));
mkdirSync(join(cwd, "src"));
mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
writeFileSync(join(cwd, "src", "node-util.ts"), "export const n = 1;\n");
writeFileSync(join(cwd, "src", "config.ts"), 'export const k = "sk-ant-api03-abc";\n');
writeFileSync(join(cwd, "src", "ok.ts"), "export {}\n");
writeFileSync(join(cwd, ".env"), "OPENAI_API_KEY=sk-live-super\n");
writeFileSync(join(cwd, ".env.example"), "OPENAI_API_KEY=\n");
writeFileSync(join(cwd, "README.md"), "hi\n");
for (let i = 0; i < 12; i++) {
  writeFileSync(join(cwd, "node_modules", "pkg", `n${i}.js`), "dep\n");
}

// Escenario: gitignore aplica al picker @
const nodeHits = completeWorkspace(cwd, "node");
assert(nodeHits.length <= 10, "picker cap 10");
assert(
  nodeHits.every((c) => !c.path.startsWith("node_modules/")),
  "picker leaked node_modules",
);
assert(
  nodeHits.some((c) => c.path === "src/node-util.ts"),
  "picker should still find src/node-util.ts",
);
console.log("ok  gitignore picker");

// Escenario: ignore del harness
assert(
  completeWorkspace(cwd, ".env").every((c) => c.path !== ".env"),
  ".env offered by picker",
);
const envAttach = hydrateOne(cwd, ".env");
assert(envAttach.status === "secret", ".env not rejected");
assert(!(envAttach.hydratedText || "").includes("sk-live-super"), "raw .env hydrated");
const readEnv = denyIfIgnored(cwd, "Read", { file_path: ".env" });
assert(readEnv?.behavior === "deny", "read .env not denied");
console.log("ok  harness ignore");

// Escenario: forzar archivo ignorado
const auto = decideAttach(cwd, "node_modules/pkg/n0.js", "auto");
assert(auto.attachment.status === "ignored", "auto should not hydrate junk");
assert(Boolean(auto.notice), "auto ignored silently");
const ask = decideAttach(cwd, "node_modules/pkg/n0.js", "ask");
assert(Boolean(ask.needsAsk), "ask should confirm junk");
const forced = hydrateForced(cwd, "node_modules/pkg/n0.js", "junk");
assert(forced.status === "ok", "force junk should hydrate");
console.log("ok  force ignored");

// Escenario: output de tool con key + vault nunca en timeline
const grep = filterGrepOrGlobOutput(
  cwd,
  "Grep",
  [
    'src/config.ts:1:export const k = "sk-ant-api03-abc";',
    ".chavez/config.json:1:accessToken=totally-secret",
    "node_modules/pkg/n0.js:1:dep",
  ].join("\n"),
);
assert(!grep.includes("sk-ant-"), "key not redacted");
assert(!grep.includes(".chavez"), "vault path in grep output");
assert(!grep.includes("accessToken"), "vault content in grep output");
assert(!grep.includes("node_modules"), "gitignore not applied to grep");
assert(grep.includes("src/config.ts"), "lost real grep hit");
console.log("ok  grep redact + vault");

// Escenario: diff no muestra secretos + git no commitea
const diff = redactDiffForCwd(
  cwd,
  [
    "diff --git a/.env b/.env",
    "--- a/.env",
    "+++ b/.env",
    "@@ -1 +1 @@",
    "-OPENAI_API_KEY=old",
    "+OPENAI_API_KEY=new",
  ].join("\n"),
);
assert(!diff.includes("old") && !diff.includes("new"), "diff leaked .env values");
assert(gitCommitBlockedReason(cwd, ".env"), "git guard missed .env");
assert(gitCommitBlockedReason(cwd, ".chavez/config.json"), "git guard missed vault");
assert(gitCommitBlockedReason(cwd, "src/ok.ts") === null, "git guard blocked source");
const writeEnv = denyIfIgnored(cwd, "Write", { file_path: ".env" });
assert(writeEnv?.message.includes("Write blocked"), "write .env not blocked");
console.log("ok  diff + git guard");

// Escenario: árbol usa el mismo ignore
const tree = listWorkspaceDir(cwd, ".");
const names = tree.entries.map((e) => e.name);
assert(!names.includes("node_modules"), "tree listed node_modules");
assert(!names.includes(".env"), "tree listed .env");
assert(names.includes("src") && names.includes("README.md"), "tree missing root files");
console.log("ok  tree ignore");

console.log(`ignore-secrets smoke passed cwd=${cwd}`);
