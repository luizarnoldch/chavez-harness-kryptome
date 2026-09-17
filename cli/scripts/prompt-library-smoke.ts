import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activePrompt,
  expandAskPrompt,
  filterPrompts,
  insertPromptAt,
  parseAskArgs,
  parseSavePromptInput,
  resolveComposerTrigger,
  type SavedPrompt,
} from "../src/llm/prompt-library";

const brief = "Review this PR for auth regressions";

function rec(name: string, body = brief): SavedPrompt {
  return {
    id: name,
    name,
    title: name,
    body,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

// 1. Guardar desde el compositor → cuenta (validate + no turn in CLI save)
{
  const saved = parseSavePromptInput({ name: "review", body: brief });
  assert.equal(saved.name, "review");
  assert.equal(saved.body, brief);
  const promptTs = readFileSync(
    join(import.meta.dir, "../src/commands/prompt.ts"),
    "utf8",
  );
  assert.equal(promptTs.includes("agent.turn"), false);
  assert.ok(promptTs.includes('"/prompts"'));
}

// 2. Insertar + mezclar con @
{
  const composer = "please #rev";
  const trigger = activePrompt(composer);
  assert.ok(trigger);
  const inserted = insertPromptAt(composer, trigger, composer.length, brief);
  assert.equal(inserted.includes("#rev"), false);
  assert.ok(inserted.includes(brief));
  const mixed = `${inserted} @src/auth.ts`;
  assert.ok(mixed.includes("@src/auth.ts"));
  assert.equal(resolveComposerTrigger(mixed)?.kind, "mention");
  const items = filterPrompts(
    [rec("review"), rec("fix-tests", "reproduce")],
    "rev",
  );
  assert.equal(items[0]?.name, "review");
  assert.ok(items.length <= 10);
}

// 3. Guardar no dispara un turn (API route + TUI/Web source)
{
  const apiRoute = readFileSync(
    join(import.meta.dir, "../../api/src/routes/prompts.ts"),
    "utf8",
  );
  assert.equal(apiRoute.includes("agent.turn"), false);
  assert.ok(apiRoute.includes("prompt.changed"));
  const webPanel = readFileSync(
    join(import.meta.dir, "../../web/src/components/ChatDetailPanel.tsx"),
    "utf8",
  );
  assert.ok(webPanel.includes('id="save-prompt-btn"') || webPanel.includes("Guardar prompt"));
  assert.ok(webPanel.includes('type="button"'));
}

// 4. CLI list + ask --prompt <name>
{
  const parsed = parseAskArgs([
    "chat-1",
    "--prompt",
    "review",
    "also",
    "@src/auth.ts",
  ]);
  assert.equal(parsed.promptName, "review");
  const expanded = expandAskPrompt({
    libraryBody: brief,
    extra: parsed.extra,
  });
  assert.equal(expanded, `${brief}\n\nalso @src/auth.ts`);
  const headless = readFileSync(
    join(import.meta.dir, "../src/commands/headless.ts"),
    "utf8",
  );
  assert.ok(headless.includes("parseAskArgs"));
  assert.ok(headless.includes("--prompt") || headless.includes("promptName"));
}

console.log("prompt-library smoke ok");
