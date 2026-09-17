// keep-in-sync with cli/src/llm/marketplace-catalog.ts
import {
  isMarketplaceId,
  marketplaceEntryInvalid,
  marketplaceNotFound,
  type MarketplaceEntry,
  type MarketplaceKind,
  type MarketplaceMcpRecipe,
} from "./marketplace-constants";

const COMMIT_BODY = `---
name: commit
description: Write a conventional commit message from the staged diff
---

# Commit

1. Run git status and git diff --staged.
2. Write a conventional commit subject ≤ 72 chars.
3. Do not commit unless the user asked.
`;

const PR_REVIEW_BODY = `---
name: pr-review
description: Review the current branch against main
---

# PR review

1. git diff main...HEAD
2. List bugs, risks, and test gaps.
3. Do not push or open a PR unless asked.
`;

export const OFFICIAL_CATALOG: MarketplaceEntry[] = [
  {
    id: "github",
    kind: "mcp",
    name: "github",
    title: "GitHub",
    description: "Repos, issues and PRs via the GitHub API",
    origin: "oficial",
    recipe: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    },
  },
  {
    id: "sequential-thinking",
    kind: "mcp",
    name: "sequential-thinking",
    title: "Sequential Thinking",
    description: "Structured multi-step reasoning",
    origin: "oficial",
    recipe: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      requiredEnv: [],
    },
  },
  {
    id: "commit",
    kind: "skill",
    name: "commit",
    title: "Commit message",
    description: "Write a conventional commit message from the staged diff",
    origin: "oficial",
    body: COMMIT_BODY,
  },
  {
    id: "pr-review",
    kind: "skill",
    name: "pr-review",
    title: "PR review",
    description: "Review the current branch against main",
    origin: "oficial",
    body: PR_REVIEW_BODY,
  },
];

export function validateMarketplaceEntry(
  e: MarketplaceEntry,
): string | null {
  if (!isMarketplaceId(e.id)) return "id must be kebab-case [a-z0-9-]+";
  if (e.kind !== "mcp" && e.kind !== "skill") return "kind must be mcp or skill";
  if (!e.name || e.name !== e.id) return "name must equal id";
  if (!e.title || !e.description) return "title and description required";
  if (e.origin !== "oficial") return "catalog origin must be oficial";
  if (e.kind === "mcp") {
    const r = e.recipe;
    if (!r) return "mcp recipe required";
    if (r.transport === "stdio") {
      if (!r.command) return "stdio recipe missing command";
    } else if (!r.url) {
      return "http/sse recipe missing url";
    }
    if (e.body) return "mcp must not include a skill body";
  } else {
    if (!e.body || e.body.length < 1) return "skill body required";
    if (e.recipe) return "skill must not include an mcp recipe";
  }
  return null;
}

export function loadOfficialCatalog(): {
  entries: MarketplaceEntry[];
  errors: string[];
} {
  const entries: MarketplaceEntry[] = [];
  const errors: string[] = [];
  for (const e of OFFICIAL_CATALOG) {
    const reason = validateMarketplaceEntry(e);
    if (reason) errors.push(marketplaceEntryInvalid(e.id, reason));
    else entries.push(e);
  }
  return { entries, errors };
}

export function lookupOfficial(
  id: string,
): { ok: true; entry: MarketplaceEntry } | { ok: false; error: string } {
  const { entries, errors } = loadOfficialCatalog();
  void errors;
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { ok: false, error: marketplaceNotFound(id) };
  return { ok: true, entry };
}

export function recipesEqual(
  a: MarketplaceMcpRecipe | undefined,
  b: MarketplaceMcpRecipe | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.transport === b.transport &&
    a.command === b.command &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    a.url === b.url
  );
}

void (0 as unknown as MarketplaceKind);
