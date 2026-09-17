/** keep-in-sync with cli/src/notifications/constants.ts */
export const NOTIFICATION_SOURCE_TYPES = [
  "chat.stream.start",
  "chat.stream.end",
  "chat.stream.error",
  "chat.tool.update",
  "chat.tool.start",
  "chat.tool.resolved",
  "chat.tool.result",
  "daemon.presence",
] as const;

export const NEVER_NOTIFY_TYPES = [
  "chat.stream.delta",
  "chat.thinking.delta",
  "message.appended",
  "agent.turn.ended",
  "agent.turn.dispatch",
] as const;

export const NO_RUNNER_LABEL = "sin runner";

export function isNotificationSourceType(type: string): boolean {
  return (NOTIFICATION_SOURCE_TYPES as readonly string[]).includes(type);
}

export function isNeverNotifyType(type: string): boolean {
  return (NEVER_NOTIFY_TYPES as readonly string[]).includes(type);
}
