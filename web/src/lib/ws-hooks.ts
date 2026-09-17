import { useMutation } from "@tanstack/react-query";
import { useWs } from "./ws-context";

export function useWsBind() {
  const ws = useWs();
  return useMutation({
    mutationFn: (path: string) => ws.bind(path),
  });
}

export function useWsUnbind() {
  const ws = useWs();
  return useMutation({
    mutationFn: () => ws.unbind(),
  });
}

export function useWsSessionCreate() {
  const ws = useWs();
  return useMutation({
    mutationFn: (title?: string) =>
      ws.request({ type: "session.create", title }),
  });
}

export function useWsChatCreate() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { sessionId: string; title?: string }) =>
      ws.request({
        type: "chat.create",
        sessionId: input.sessionId,
        title: input.title,
      }),
  });
}

export function useWsChatUpdate() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      sessionId?: string;
    }) => ws.request({ type: "chat.update", ...input }),
  });
}

export function useWsChatAppend() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      content: string;
      role?: string;
      metadata?: Record<string, unknown>;
    }) =>
      ws.request({
        type: "chat.append",
        chatId: input.chatId,
        content: input.content,
        role: input.role || "user",
        metadata: input.metadata,
      }),
  });
}

export function useWsChatGet() {
  const ws = useWs();
  return useMutation({
    mutationFn: (chatId: string) => ws.request({ type: "chat.get", chatId }),
  });
}

export type FsCandidate = { path: string; isDir: boolean };

export function useWsFsComplete() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string; query: string }) =>
      ws.request({
        type: "fs.complete",
        chatId: input.chatId,
        query: input.query,
      }),
  });
}

export type FsTreeEntry = { name: string; path: string; isDir: boolean };

export function useWsFsTree() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { path?: string }) =>
      ws.request({
        type: "fs.tree",
        path: input.path || ".",
      }),
  });
}

export function useWsFsSearch() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { query: string }) =>
      ws.request({
        type: "fs.search",
        query: input.query,
      }),
  });
}

export function useWsFsPreview() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { path: string }) =>
      ws.request({
        type: "fs.preview",
        path: input.path,
      }),
  });
}

export function useWsGitStatus() {
  const ws = useWs();
  return useMutation({
    mutationFn: () => ws.request({ type: "workspace.git.status" }),
  });
}

export function useWsGitDiff() {
  const ws = useWs();
  return useMutation({
    mutationFn: () => ws.request({ type: "workspace.git.diff" }),
  });
}

export function useWsAgentTurn() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      prompt: string;
      mentions?: string[];
      enqueue?: boolean;
    }) =>
      ws.request({
        type: "agent.turn.request",
        chatId: input.chatId,
        prompt: input.prompt,
        enqueue: input.enqueue,
        metadata: input.mentions?.length
          ? { mentions: input.mentions }
          : undefined,
      }),
  });
}

export function useWsQueueCancel() {
  const ws = useWs();
  return useMutation({
    mutationFn: (queueId: string) =>
      ws.request({ type: "agent.queue.cancel", queueId }),
  });
}

export function useWsTurnUndo() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string }) =>
      ws.request({ type: "agent.turn.undo", chatId: input.chatId }, 30_000),
  });
}

export function useWsTurnRetry() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string }) =>
      ws.request({ type: "agent.turn.retry", chatId: input.chatId }, 30_000),
  });
}

export function useWsRulesSnapshot() {
  const ws = useWs();
  return useMutation({
    mutationFn: () => ws.request({ type: "workspace.rules.snapshot" }),
  });
}

export function useWsRulesLocalSet() {
  const ws = useWs();
  return useMutation({
    mutationFn: (content: string) =>
      ws.request({
        type: "workspace.rules.local.set",
        payload: { content },
      }),
  });
}

export function useWsPlanUpdate() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      artifactId: string;
      markdown: string;
    }) =>
      ws.request({
        type: "chat.plan.update",
        chatId: input.chatId,
        artifactId: input.artifactId,
        markdown: input.markdown,
      }),
  });
}

export function useWsPlanApply() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string; artifactId?: string }) =>
      ws.request({
        type: "chat.plan.apply",
        chatId: input.chatId,
        artifactId: input.artifactId,
      }),
  });
}

export function useWsPlanSetCurrent() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string; artifactId: string }) =>
      ws.request({
        type: "chat.plan.setCurrent",
        chatId: input.chatId,
        artifactId: input.artifactId,
      }),
  });
}

export function useWsChatCompact() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string }) =>
      ws.request({ type: "chat.compact", chatId: input.chatId }, 90_000),
  });
}

export function useWsAgentCancel() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string }) =>
      ws.request({ type: "agent.turn.cancel", chatId: input.chatId }),
  });
}

export function useWsAgentSteer() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string; content: string }) =>
      ws.request({
        type: "agent.turn.steer",
        chatId: input.chatId,
        content: input.content,
      }),
  });
}

export function useWsToolResolve() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      toolCallId: string;
      decision: "approve" | "deny";
    }) =>
      ws.request({
        type:
          input.decision === "approve"
            ? "agent.tool.approve"
            : "agent.tool.deny",
        chatId: input.chatId,
        toolCallId: input.toolCallId,
      }),
  });
}
