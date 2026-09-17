export type PtyKind = "user" | "agent";
export type PtyStatus = "starting" | "open" | "exited" | "killed";

export type PtyOpenInput = {
  kind: PtyKind;
  ownerConnectionId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  command?: string;
  chatId?: string;
  toolCallId?: string;
  workspaceId?: string;
};

export type PtyOpenResult = {
  ptyId: string;
  pid: number;
  hostname: string;
  cwd: string;
  cols: number;
  rows: number;
  kind: PtyKind;
  shell: string;
};

export type PtyGateDecision =
  | { action: "allow" }
  | { action: "deny"; message: string }
  | { action: "ask" };
