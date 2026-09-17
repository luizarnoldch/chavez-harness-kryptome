import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpFromDisk } from "../src/llm/mcp-load";
import { loadSkillsFromDisk } from "../src/llm/skills-load";
import {
  createSubagentBudget,
  trySpawnSubagent,
} from "../src/llm/subagent-budget";
import { CLAUDE_CAPS, cursorCapsStatic } from "../src/llm/provider-caps";

const dir = mkdtempSync(join(tmpdir(), "chavez-mcp-"));
writeFileSync(
  join(dir, ".mcp.json"),
  JSON.stringify({ mcpServers: { broken: { command: "__nope__" } } }),
);
mkdirSync(join(dir, ".claude/skills/demo"), { recursive: true });
writeFileSync(
  join(dir, ".claude/skills/demo/SKILL.md"),
  "---\nname: demo\ndescription: demo skill\n---\nDo the demo.\n",
);
const mcp = loadMcpFromDisk(dir, { localFile: join(dir, "nolocal") });
if (mcp.servers.length !== 1) throw new Error("expected 1 mcp server config");
const skills = loadSkillsFromDisk(
  dir,
  [{ name: "demo", description: "user", body: "user body", enabled: true }],
  { localDir: join(dir, "nomachine") },
);
if (skills.applied[0]?.layer !== "project") {
  throw new Error("project should override user skill");
}
let b = createSubagentBudget();
for (let i = 0; i < 8; i++) {
  const r = trySpawnSubagent(b, 1);
  if (!r.ok) throw new Error("spawn should succeed");
  b = r.next;
}
if (trySpawnSubagent(b, 1).ok) throw new Error("9th spawn must fail");
if (!CLAUDE_CAPS.mcp || cursorCapsStatic().nestedSubagentTools) {
  throw new Error("caps mismatch");
}
console.log("mcp-skills-smoke ok", dir);
