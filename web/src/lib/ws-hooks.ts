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

export function useWsChatAppend() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      content: string;
      role?: string;
    }) =>
      ws.request({
        type: "chat.append",
        chatId: input.chatId,
        content: input.content,
        role: input.role || "user",
      }),
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

export function useWsAgentTurn() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      prompt: string;
      mentions?: string[];
    }) =>
      ws.request({
        type: "agent.turn.request",
        chatId: input.chatId,
        prompt: input.prompt,
        metadata: input.mentions?.length
          ? { mentions: input.mentions }
          : undefined,
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
