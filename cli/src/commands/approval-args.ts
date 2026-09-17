export function parseApproveArgs(
  action: string,
  rest: string[],
): { action: "approve" | "deny"; chatId: string; toolCallId: string } {
  if (action !== "approve" && action !== "deny") {
    throw new Error("not an approval action");
  }
  const chatId = rest[0];
  const toolCallId = rest[1];
  if (!chatId || !toolCallId) {
    throw new Error(`Uso: … chat ${action} <chatId> <toolCallId>`);
  }
  return { action, chatId, toolCallId };
}
