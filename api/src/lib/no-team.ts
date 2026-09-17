import {
  UNAUTHORIZED,
  NOT_FOUND_WORKSPACE,
  NOT_FOUND_SESSION,
  NOT_FOUND_CHAT,
  NO_DAEMON_ERROR,
} from "../ws/errors";
import {
  SHARE_READONLY_BANNER,
  SHARE_NOT_FOUND,
} from "../chats/export-share";

export {
  UNAUTHORIZED,
  NOT_FOUND_WORKSPACE,
  NOT_FOUND_SESSION,
  NOT_FOUND_CHAT,
  NO_DAEMON_ERROR,
  SHARE_READONLY_BANNER,
  SHARE_NOT_FOUND,
};

export const CREDENTIALS_NOT_LINKED = "Credentials not linked";
export const NO_TEAM_PRODUCT =
  "Chavez has no team product. One user = their vault, chats, and daemons.";
export const SHARE_NOT_MEMBERSHIP =
  "A read-only share link is not membership";
export const OWNERSHIP_STATUS_FOREIGN = 404 as const;
export const OWNERSHIP_STATUS_UNAUTH = 401 as const;
export const FORBIDDEN_STATUS = 403 as const;

export const FORBIDDEN_TABLE_NAMES = [
  "organization",
  "organizations",
  "member",
  "members",
  "invitation",
  "invitations",
  "team",
  "teams",
  "team_member",
  "team_members",
  "workspace_member",
  "workspace_members",
  "org",
  "orgs",
  "role",
  "roles",
  "membership",
  "memberships",
] as const;

export const FORBIDDEN_COLUMN_NAMES = [
  "org_id",
  "organization_id",
  "team_id",
  "member_id",
  "member_role",
  "workspace_role",
  "active_organization_id",
  "activeOrganizationId",
  "orgId",
  "organizationId",
  "teamId",
] as const;

export const FORBIDDEN_HTTP_PATHS = [
  "/orgs",
  "/organizations",
  "/teams",
  "/invites",
  "/invitations",
  "/members",
  "/workspace-members",
  "/org",
  "/team",
  "/invite",
  "/memberships",
] as const;

export const FORBIDDEN_AUTH_NEEDLES = [
  "organization(",
  "admin(",
  "organizationClient(",
  "activeOrganizationId",
] as const;

export const ALLOWED_PG_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "device_code",
  "provider_credentials",
  "user_preferences",
  "user_rules",
  "user_skills",
  "provider_catalogs",
  "workspaces",
  "agent_sessions",
  "chats",
  "chat_messages",
  "saved_prompts",
  "memories",
  "chat_share_links",
  "turn_file_diffs",
] as const;

export const ALLOWED_MESSAGE_ROLES = [
  "user",
  "assistant",
  "system",
  "tool",
] as const;

export function missingJson(entity: "workspace" | "session" | "chat" | "share") {
  const error =
    entity === "workspace"
      ? NOT_FOUND_WORKSPACE
      : entity === "session"
        ? NOT_FOUND_SESSION
        : entity === "share"
          ? SHARE_NOT_FOUND
          : NOT_FOUND_CHAT;
  return { error };
}

export function hasForbiddenTeamToken(text: string): boolean {
  for (const col of FORBIDDEN_COLUMN_NAMES) {
    if (text.includes(col)) return true;
  }
  return false;
}

export function pgTableNames(schemaSrc: string): string[] {
  const names: string[] = [];
  const re = /pgTable\(\s*["']([a-z0-9_]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schemaSrc))) names.push(m[1]!);
  return names;
}

export function assertNoForbiddenTables(schemaSrc: string): string[] {
  const found = pgTableNames(schemaSrc);
  return found.filter((n) =>
    (FORBIDDEN_TABLE_NAMES as readonly string[]).includes(n),
  );
}

export function extractBlock(src: string, exportName: string): string {
  const needle = `export const ${exportName}`;
  const start = src.indexOf(needle);
  if (start < 0) return "";
  const next = src.indexOf("export const ", start + needle.length);
  return next < 0 ? src.slice(start) : src.slice(start, next);
}
