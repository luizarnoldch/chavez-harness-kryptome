export function replayEscapeCloses(view: "chat" | "replay"): "chat" | "replay" {
  return view === "replay" ? "chat" : view;
}

export function isReplayReadOnlyKey(ch: string): boolean {
  return ch === "y" || ch === "n" || ch === "m" || ch === "u" || ch === "r";
}
