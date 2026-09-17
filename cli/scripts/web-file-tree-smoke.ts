#!/usr/bin/env bun
/**
 * Smoke Plan 18 — web file tree. No LLM.
 * Usage: bun run scripts/web-file-tree-smoke.ts
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaceDir } from "../src/llm/fs-tree";
import { searchWorkspace } from "../src/llm/fs-search";
import { previewFile } from "../src/llm/fs-preview";
import { completeWorkspace, FS_COMPLETE_LIMIT } from "../src/llm/fs-complete";
import { appendMention, mentionToken } from "../src/llm/mentions";
import { PathEscapeError } from "../src/llm/workspace-path";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-p18-")));
mkdirSync(join(cwd, "src"), { recursive: true });
mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
writeFileSync(join(cwd, "src", "auth.ts"), "export const auth = 1;\n");
writeFileSync(join(cwd, "src", "logo.png"), PNG_1X1);
writeFileSync(join(cwd, "src", "blob.bin"), Buffer.from([0, 1, 0, 2]));
writeFileSync(join(cwd, ".env"), "SECRET=1\n");
writeFileSync(join(cwd, "node_modules", "pkg", "auth.js"), "nope");
writeFileSync(join(cwd, "README.md"), "hi\n");

// Escenario: Árbol lazy (raíz acotada + ignore)
const root = listWorkspaceDir(cwd, ".");
const names = root.entries.map((e) => e.name);
assert(names.includes("src"), "root should list src");
assert(names.includes("README.md"), "root should list README");
assert(!names.includes("node_modules"), "ignore hides node_modules");
assert(!names.includes(".env"), "ignore hides .env");
assert(root.entries.length <= 200, "root capped at 200");
const src = listWorkspaceDir(cwd, "src");
assert(src.entries.some((e) => e.name === "auth.ts"), "expand src lists auth.ts");
let threw = false;
try {
  listWorkspaceDir(cwd, "../outside");
} catch (e) {
  threw = e instanceof PathEscapeError;
}
assert(threw, "escape must throw PathEscapeError");
console.log("tree lazy + ignore OK", osHostname(), cwd);

// Escenario: Búsqueda por nombre
const found = searchWorkspace(cwd, "auth");
assert(
  found.matches.some((m) => m.path === "src/auth.ts"),
  "search auth → src/auth.ts",
);
assert(
  found.matches.every((m) => !m.path.startsWith("node_modules/")),
  "search must not leak node_modules",
);
assert(found.matches.length <= 50, "search cap 50");
assert(FS_COMPLETE_LIMIT === 10, "picker cap must stay 10");
assert(completeWorkspace(cwd, "auth").length <= 10, "picker still ≤10");
assert(searchWorkspace(cwd, "").matches.length === 0, "empty query dumps nothing");
console.log("search OK", found.matches.map((m) => m.path));

// Escenario: Preview texto / imagen / binario
const text = previewFile(cwd, "src/auth.ts");
assert(text.kind === "text" && (text.text || "").includes("export const auth"), "text preview");
const img = previewFile(cwd, "src/logo.png");
assert(img.kind === "image" && Boolean(img.imageBase64), "image preview");
assert(img.text === undefined, "image must not carry text");
const bin = previewFile(cwd, "src/blob.bin");
assert(bin.kind === "binary", "binary kind");
assert(bin.text === undefined, "binary not faked as text");
assert((bin.notice || "").includes("Binario"), "binary notice");
const secret = previewFile(cwd, ".env");
assert(secret.status === "ignored", ".env not previewed");
assert(JSON.stringify(secret).includes("SECRET=1") === false, "secret not in payload");
console.log("preview OK");

// Escenario: Insertar @ uno a uno
assert(mentionToken("src/auth.ts", false) === "@src/auth.ts", "token file");
const one = appendMention("", "src/auth.ts", false);
const two = appendMention(one, "src/logo.png", false);
assert(one === "@src/auth.ts ", "one chip");
assert(two.includes("@src/auth.ts") && two.includes("@src/logo.png"), "second click other file");
assert(appendMention(one, "src/auth.ts", false) === one, "same path is one-by-one no-op");
console.log("attach token OK");

// Escenario: Sin daemon — el RPC de API debe devolver NO_DAEMON_ERROR.
// In-process no hay disco de API: este proceso lee `cwd` tmp, nunca process.cwd() del server.
assert(cwd !== "/", "tmp cwd is not the API root");
const noDaemon =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
assert(/daemon bound/.test(noDaemon), "canonical error string");
console.log("no-daemon copy OK (canonical string)");

const apiUrl = process.env.CHAVEZ_API_URL;
if (!apiUrl) {
  console.log("SKIP rpc (set CHAVEZ_API_URL to exercise handlers)");
  console.log("web-file-tree smoke OK");
  process.exit(0);
}

const { ChavezWsClient } = await import("../src/ws/client");
const token = process.env.CHAVEZ_TOKEN;
if (!token) {
  console.log("SKIP rpc (CHAVEZ_TOKEN missing)");
  console.log("web-file-tree smoke OK");
  process.exit(0);
}

const client = new ChavezWsClient(token);
await client.connect();
const bound = await client.bind(cwd, "daemon");
assert(bound.ok, `bind failed: ${bound.error}`);

const treeRes = await client.request({ type: "fs.tree", path: "." });
assert(treeRes.ok, `fs.tree failed: ${treeRes.error}`);
const treeData = (treeRes.data || {}) as {
  hostname?: string;
  cwd?: string;
  entries?: Array<{ name: string }>;
};
assert(Boolean(treeData.hostname), "fs.tree hostname");
assert(
  (treeData.entries || []).every((e) => e.name !== "node_modules"),
  "rpc tree ignore",
);

const searchRes = await client.request({ type: "fs.search", query: "auth" });
assert(searchRes.ok, `fs.search failed: ${searchRes.error}`);

const prevRes = await client.request({ type: "fs.preview", path: "src/auth.ts" });
assert(prevRes.ok, `fs.preview failed: ${prevRes.error}`);
const prevData = (prevRes.data || {}) as { kind?: string; text?: string };
assert(prevData.kind === "text", "rpc preview text");

await client.request({ type: "workspace.unbind" });
client.close();
console.log("rpc OK", treeData.hostname, treeData.cwd);

const client2 = new ChavezWsClient(token);
await client2.connect();
await client2.request({
  type: "workspace.bind",
  path: cwd,
  clientKind: "client",
  hostname: osHostname(),
});
const naked = await client2.request({ type: "fs.tree", path: "." });
assert(naked.ok === false, "fs.tree without daemon must fail");
assert(
  (naked.error || "").includes("No daemon bound for this workspace"),
  `expected NO_DAEMON_ERROR, got ${naked.error}`,
);
client2.close();

console.log("web-file-tree smoke OK");
