import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleBundle, denyIfRuleDisallowed } from "../src/llm/rules-merge";
import { loadLocalRules, loadProjectRules } from "../src/llm/rules-load";
import { parseRuleFile, toRuleSource } from "../src/llm/rules-parse";
import {
  ensureLocalRulesGitExcluded,
  localRuleCommitBlockedReason,
} from "../src/llm/rules-git-exclude";
import { loadTurnRules } from "../src/llm/rules-inject";

function assertCond(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-p9-")));

// Escenario: Sin archivos de reglas → no throw
{
  const empty = loadTurnRules({ cwd: realpathSync(mkdtempSync(join(tmpdir(), "chavez-p9e-"))) });
  assert.equal(empty.metadata.counts.total, 0);
  assert.equal(empty.appendSystemPrompt, undefined);
  console.log("ok  missing AGENTS.md does not fail");
}

writeFileSync(join(cwd, "AGENTS.md"), "# Agents\nuse bun test\n");
writeFileSync(join(cwd, "CLAUDE.md"), "# Claude native\nno force-push\n");
mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
writeFileSync(
  join(cwd, ".cursor", "rules", "ts.mdc"),
  "---\nalwaysApply: true\n---\n# Cursor TS\nprefer type imports\n",
);
writeFileSync(
  join(cwd, "CHAVEZ.local.md"),
  "---\ndisallowTools: [bash]\ntitle: No bash\n---\nno uses bash\n",
);

// Escenario: Proyecto carga AGENTS y nativos
{
  const project = loadProjectRules(cwd);
  const paths = project.map((r) => r.path);
  assertCond(paths.includes("AGENTS.md"), "AGENTS.md not loaded");
  assertCond(paths.includes("CLAUDE.md"), "CLAUDE.md not loaded");
  assertCond(paths.includes(".cursor/rules/ts.mdc"), "cursor native not loaded");
  assertCond(!paths.includes("CHAVEZ.local.md"), "local leaked into project");
  console.log("ok  project loads AGENTS + natives, not local");
}

// Escenario: Las tres capas se inyectan; local gana
{
  const user = [
    toRuleSource(
      "user",
      parseRuleFile("responde en español", "user"),
      { id: "u1", enabled: true },
    ),
  ];
  user[0]!.title = "español";
  const loaded = loadTurnRules({
    cwd,
    userRules: [
      {
        id: "u1",
        title: "español",
        body: "responde en español",
        enabled: true,
      },
    ],
    userRulesEnabled: true,
  });
  const text = loaded.appendSystemPrompt || "";
  assert.match(text, /responde en español/);
  assert.match(text, /use bun test/);
  assert.match(text, /no uses bash/);
  assert.match(text, /local overrides project/);
  assert.equal(loaded.bundle.disallowedTools.includes("bash"), true);
  // conflicto explícito: user allow bash, local disallow → local gana
  const conflict = assembleBundle({
    user: [
      toRuleSource("user", parseRuleFile("---\nallowTools: [bash]\n---\nok bash\n", "u"), {
        enabled: true,
      }),
    ],
    project: loadProjectRules(cwd),
    local: loadLocalRules(cwd),
    userRulesEnabled: true,
  });
  assert.equal(conflict.disallowedTools.includes("bash"), true);
  console.log("ok  three layers injected; local wins conflict");
}

// Escenario: Usuario sigue entre workspaces + se puede desactivar
{
  const other = loadTurnRules({
    cwd: realpathSync(mkdtempSync(join(tmpdir(), "chavez-p9w-"))),
    userRules: [
      { id: "u1", title: "español", body: "responde en español", enabled: true },
    ],
    userRulesEnabled: true,
  });
  assert.match(other.appendSystemPrompt || "", /responde en español/);
  const disabled = loadTurnRules({
    cwd,
    userRules: [
      { id: "u1", title: "español", body: "responde en español", enabled: true },
    ],
    userRulesEnabled: false,
  });
  assert.doesNotMatch(disabled.appendSystemPrompt || "", /responde en español/);
  assert.match(disabled.appendSystemPrompt || "", /use bun test/);
  console.log("ok  user rules follow workspaces and can be disabled");
}

// Escenario: Visible títulos, no body enorme
{
  const meta = loadTurnRules({ cwd }).metadata;
  assert.ok(meta.counts.project >= 2);
  assert.ok(meta.counts.local >= 1);
  for (const a of meta.applied) {
    assert.ok(a.title);
    assert.equal("body" in a, false);
  }
  console.log("ok  metadata titles only");
}

// Escenario: Local no se sube a git
{
  mkdirSync(join(cwd, ".git", "info"), { recursive: true });
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  ensureLocalRulesGitExcluded(cwd);
  const ex = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
  assert.match(ex, /CHAVEZ\.local\.md/);
  assert.match(ex, /CLAUDE\.local\.md/);
  assert.match(ex, /\.chavez\//);
  assert.ok(localRuleCommitBlockedReason("CHAVEZ.local.md"));
  assert.equal(localRuleCommitBlockedReason("AGENTS.md"), null);
  console.log("ok  local not commited");
}

// Escenario: Regla local no-bash + auto → deny
{
  const loaded = loadTurnRules({ cwd });
  const denied = denyIfRuleDisallowed(loaded.bundle, "bash");
  assert.equal(denied?.behavior, "deny");
  assert.match(denied?.message || "", /bash/);
  assert.equal(denyIfRuleDisallowed(loaded.bundle, "read"), null);
  console.log("ok  local bash disallow denies even when mode would allow");
}

console.log("rules smoke unit OK", cwd);

{
  const { loadConfig } = await import("../src/config");
  const { apiFetch } = await import("../src/api-client");
  const token = process.env.CHAVEZ_ACCESS_TOKEN || loadConfig().accessToken;
  if (!token) {
    console.log("skip live HTTP");
  } else {
    try {
      const created = await apiFetch<{ rule: { id: string; title: string } }>(
        "/rules",
        {
          method: "POST",
          body: JSON.stringify({
            title: "español",
            body: "responde en español",
            enabled: true,
          }),
        },
        token,
      );
      assert.equal(created.rule.title, "español");
      const listed = await apiFetch<{ rules: Array<{ id: string }> }>(
        "/rules",
        {},
        token,
      );
      assert.ok(listed.rules.some((r) => r.id === created.rule.id));
      await apiFetch(`/rules/${created.rule.id}`, { method: "DELETE" }, token);
      console.log("ok  live HTTP user rules");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/401|404|Unauthorized|Not Found/i.test(msg)) {
        console.log("skip live HTTP");
      } else {
        throw err;
      }
    }
  }
}
