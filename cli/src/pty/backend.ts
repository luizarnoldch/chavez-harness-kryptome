export type PtyChild = {
  pid: number;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  onData(cb: (chunk: Uint8Array) => void): () => void;
  onExit(
    cb: (info: { exitCode: number | null; signal: string | null }) => void,
  ): () => void;
};

export type PtyBackend = {
  spawn(input: {
    cwd: string;
    env: Record<string, string>;
    file: string;
    args: string[];
    cols: number;
    rows: number;
  }): PtyChild;
};
