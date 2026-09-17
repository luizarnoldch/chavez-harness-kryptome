const USAGE =
  "Uso: chavez marketplace list [--json]\n" +
  "     chavez marketplace install skill <id>\n" +
  "     chavez marketplace install mcp <id>\n" +
  "     chavez marketplace uninstall skill <name>\n" +
  "     chavez marketplace uninstall mcp <name>";

export type ParsedMarketplaceArgs =
  | { action: "list"; json?: boolean }
  | { action: "install"; kind: "skill" | "mcp"; id: string }
  | { action: "uninstall"; kind: "skill" | "mcp"; name: string };

export function marketplaceUsage(): never {
  throw new Error(USAGE);
}

export function parseMarketplaceArgs(args: string[]): ParsedMarketplaceArgs {
  const [action, ...rest] = args;
  if (!action || action === "list") {
    return { action: "list", json: rest.includes("--json") };
  }
  if (action === "install") {
    const kind = rest[0];
    const id = rest[1];
    if ((kind !== "skill" && kind !== "mcp") || !id) marketplaceUsage();
    return { action: "install", kind, id };
  }
  if (action === "uninstall") {
    const kind = rest[0];
    const name = rest[1];
    if ((kind !== "skill" && kind !== "mcp") || !name) marketplaceUsage();
    return { action: "uninstall", kind, name };
  }
  marketplaceUsage();
}
