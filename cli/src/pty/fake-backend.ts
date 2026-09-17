import type { PtyBackend, PtyChild } from "./backend";

export type FakePtyChild = PtyChild & {
  writes: Uint8Array[];
  killed: Array<NodeJS.Signals | undefined>;
  unrefCalled: boolean;
  emitData(s: string | Uint8Array): void;
  emitExit(exitCode: number | null, signal?: string | null): void;
};

export function createFakeBackend(): PtyBackend & {
  children: FakePtyChild[];
  autoExitOnKill: boolean;
} {
  const children: FakePtyChild[] = [];
  const backend: PtyBackend & {
    children: FakePtyChild[];
    autoExitOnKill: boolean;
  } = {
    children,
    autoExitOnKill: true,
    spawn(input) {
      const dataCbs: Array<(chunk: Uint8Array) => void> = [];
      const exitCbs: Array<
        (info: { exitCode: number | null; signal: string | null }) => void
      > = [];
      const child: FakePtyChild = {
        pid: 40000 + children.length,
        writes: [],
        killed: [],
        unrefCalled: false,
        write(data) {
          this.writes.push(data);
        },
        resize() {},
        kill(signal) {
          this.killed.push(signal);
          if (backend.autoExitOnKill) {
            for (const cb of exitCbs) {
              cb({ exitCode: null, signal: signal ?? null });
            }
          }
        },
        onData(cb) {
          dataCbs.push(cb);
          return () => {
            const index = dataCbs.indexOf(cb);
            if (index >= 0) dataCbs.splice(index, 1);
          };
        },
        onExit(cb) {
          exitCbs.push(cb);
          return () => {
            const index = exitCbs.indexOf(cb);
            if (index >= 0) exitCbs.splice(index, 1);
          };
        },
        emitData(s) {
          const buffer =
            typeof s === "string" ? new TextEncoder().encode(s) : s;
          for (const cb of dataCbs) cb(buffer);
        },
        emitExit(exitCode, signal = null) {
          for (const cb of exitCbs) cb({ exitCode, signal });
        },
      };
      children.push(child);
      void input;
      return child;
    },
  };
  return backend;
}
