import { NO_USAGE_TEXT, type ChatUsageView } from "../lib/usage-codec";
import type { ChatMessage } from "../lib/hooks";
import { formatChatUsage, formatTurnUsageLine } from "../lib/usage-codec";

export function ChatUsagePanel({
  usage,
  messages,
}: {
  usage?: ChatUsageView | null;
  messages: ChatMessage[];
}) {
  const display =
    usage?.display ?? formatChatUsage(messages);
  return (
    <div className="panel" data-testid="chat-usage">
      <h2>Costo</h2>
      <pre
        style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: "0.85rem" }}
        className={display === NO_USAGE_TEXT ? "muted" : undefined}
      >
        {display}
      </pre>
    </div>
  );
}

export function TurnCostBadge({ message }: { message: ChatMessage }) {
  if (message.role !== "assistant") return null;
  const line = formatTurnUsageLine(message.metadata);
  if (!line) return null;
  return <span className="badge">{line}</span>;
}
