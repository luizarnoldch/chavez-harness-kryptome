export type SdkUserLike = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  uuid: string;
  session_id: string;
};

function userMsg(text: string): SdkUserLike {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "",
  };
}

/**
 * Keeps the Claude query iterable open so mid-turn user messages can fold in.
 * close() after result/cancel or the query hangs waiting for the next prompt.
 */
export class PromptStream {
  private queue: Array<SdkUserLike | null> = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private steered = 0;

  get isClosed(): boolean {
    return this.closed;
  }

  get steerCount(): number {
    return this.steered;
  }

  /** @returns false if already closed (caller must revert_to_followup). */
  pushSteer(text: string): boolean {
    if (this.closed) return false;
    this.queue.push(userMsg(text));
    this.steered += 1;
    this.flush();
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.push(null);
    this.flush();
  }

  async *iterate(initial: string): AsyncGenerator<SdkUserLike> {
    yield userMsg(initial);
    while (true) {
      while (this.queue.length === 0) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
      const next = this.queue.shift();
      if (next == null) return;
      yield next;
    }
  }

  private flush(): void {
    const w = this.waiters.splice(0);
    for (const fn of w) fn();
  }
}
