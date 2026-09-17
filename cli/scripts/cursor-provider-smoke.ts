/**
 * Optional live smoke:
 *   CURSOR_API_KEY=... bun run cli/scripts/cursor-provider-smoke.ts
 * Exits 2 if no key (skip). Never prints the key.
 */
import { Agent, Cursor } from "@cursor/sdk";
import { hasCursorRouter, parseCursorModels } from "../src/llm/catalog-codec";
import type { CursorCatalog } from "../src/llm/cursor-types";

const key = process.env.CURSOR_API_KEY?.trim();
if (!key) {
  console.error("SKIP: set CURSOR_API_KEY to run live Cursor smoke");
  process.exit(2);
}

const listed = await Cursor.models.list({ apiKey: key });
const models = parseCursorModels({ provider: "cursor", models: listed });
const catalog: CursorCatalog = { id: "cursor", label: "Cursor", models };
const hasRouter = hasCursorRouter(catalog);
console.log(`models=${models.length} router=${hasRouter}`);

const first = models[0];
if (!first) {
  console.error("FAIL: empty catalog");
  process.exit(1);
}

const createOpts = {
  apiKey: key,
  model: { id: first.id },
  local: { cwd: process.cwd() },
};
if ("cloud" in createOpts) {
  console.error("FAIL: cloud leaked into Agent.create options");
  process.exit(1);
}

const agent = await Agent.create(createOpts);
const run = await agent.send("say hi in one word");
const result = await run.wait();
console.log("status", result.status);
await agent[Symbol.asyncDispose]();
console.log("CURSOR SMOKE PASS");
