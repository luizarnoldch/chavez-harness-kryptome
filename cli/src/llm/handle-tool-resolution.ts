import type { WsPushMessage } from "../ws/client";
import { resolveApproval } from "./tool-approval";

export function handleToolResolutionPush(msg: WsPushMessage): boolean {
  if (msg.type !== "agent.tool.approve" && msg.type !== "agent.tool.deny") {
    return false;
  }
  const data = (msg.data || {}) as { toolCallId?: string };
  if (!data.toolCallId) return true;
  const outcome = msg.type === "agent.tool.approve" ? "approve" : "deny";
  resolveApproval(data.toolCallId, outcome);
  return true;
}
