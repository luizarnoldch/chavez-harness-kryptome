import { CString, dlopen, FFIType, ptr } from "bun:ffi";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { PtyBackend, PtyChild } from "./backend";
import { PTY_CHUNK_MAX_BYTES, PTY_UNSUPPORTED } from "./constants";

type Libc = ReturnType<typeof loadLibc>;

export const PTY_SETSID_PATH = "/usr/bin/setsid";

export function resolvePtySpawnCommand(
  file: string,
  args: string[],
  setsidExists = fs.existsSync(PTY_SETSID_PATH),
): { file: string; args: string[] } {
  return setsidExists
    ? { file: PTY_SETSID_PATH, args: [file, ...args] }
    : { file, args };
}

function loadLibc() {
  const library =
    process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
  return dlopen(library, {
    posix_openpt: {
      args: [FFIType.i32],
      returns: FFIType.i32,
    },
    grantpt: {
      args: [FFIType.i32],
      returns: FFIType.i32,
    },
    unlockpt: {
      args: [FFIType.i32],
      returns: FFIType.i32,
    },
    ptsname: {
      args: [FFIType.i32],
      returns: FFIType.ptr,
    },
    ioctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    close: {
      args: [FFIType.i32],
      returns: FFIType.i32,
    },
    fcntl: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  });
}

let libc: Libc | undefined;

function getLibc(): Libc {
  libc ??= loadLibc();
  return libc;
}

export function assertPtyPlatform(platform: string): void {
  if (platform === "win32") {
    throw new Error(PTY_UNSUPPORTED);
  }
}

export function isPtyPlatformSupported(): boolean {
  return process.platform !== "win32";
}

function check(result: number, operation: string): void {
  if (result < 0) {
    throw new Error(`${operation} failed`);
  }
}

function resizePty(masterFd: number, cols: number, rows: number): void {
  const winsize = new Uint16Array([rows, cols, 0, 0]);
  const request = process.platform === "darwin" ? 0x80087467 : 0x5414;
  check(
    getLibc().symbols.ioctl(masterFd, request, ptr(winsize)),
    "ioctl(TIOCSWINSZ)",
  );
}

export const nativePtyBackend: PtyBackend = {
  spawn(input): PtyChild {
    assertPtyPlatform(process.platform);
    const native = getLibc();
    const openFlags = process.platform === "darwin" ? 0x20002 : 0x102;
    const masterFd = native.symbols.posix_openpt(openFlags);
    check(masterFd, "posix_openpt");

    let slaveFd: number | undefined;
    try {
      check(native.symbols.grantpt(masterFd), "grantpt");
      check(native.symbols.unlockpt(masterFd), "unlockpt");
      const slavePointer = native.symbols.ptsname(masterFd);
      if (!slavePointer) throw new Error("ptsname failed");
      const slavePath = new CString(slavePointer).toString();
      slaveFd = fs.openSync(slavePath, "r+");
      resizePty(masterFd, input.cols, input.rows);

      const command = resolvePtySpawnCommand(input.file, input.args);
      const child = spawn(command.file, command.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: [slaveFd, slaveFd, slaveFd],
        detached: false,
        windowsHide: true,
      });
      fs.closeSync(slaveFd);
      slaveFd = undefined;

      const dataCallbacks = new Set<(chunk: Uint8Array) => void>();
      const exitCallbacks = new Set<
        (info: { exitCode: number | null; signal: string | null }) => void
      >();
      let masterClosed = false;
      let exitInfo:
        | { exitCode: number | null; signal: string | null }
        | undefined;

      const closeMaster = () => {
        if (masterClosed) return;
        masterClosed = true;
        native.symbols.close(masterFd);
      };

      const buffer = Buffer.allocUnsafe(PTY_CHUNK_MAX_BYTES);
      const readNext = () => {
        if (masterClosed) return;
        fs.read(masterFd, buffer, 0, buffer.length, null, (error, bytesRead) => {
          if (!error && bytesRead > 0) {
            const chunk = Uint8Array.from(buffer.subarray(0, bytesRead));
            for (const callback of dataCallbacks) callback(chunk);
            readNext();
          }
        });
      };
      readNext();

      child.on("exit", (exitCode, signal) => {
        // Drain remaining master bytes before close — exit can race ahead of read().
        if (!masterClosed) {
          try {
            for (;;) {
              const bytesRead = fs.readSync(
                masterFd,
                buffer,
                0,
                buffer.length,
                null,
              );
              if (bytesRead <= 0) break;
              const chunk = Uint8Array.from(buffer.subarray(0, bytesRead));
              for (const callback of dataCallbacks) callback(chunk);
            }
          } catch {
            // master already closed or EIO after slave hangup
          }
        }
        closeMaster();
        exitInfo = { exitCode, signal };
        for (const callback of exitCallbacks) callback(exitInfo);
      });

      return {
        pid: child.pid!,
        write(data) {
          fs.writeSync(
            masterFd,
            data.subarray(0, PTY_CHUNK_MAX_BYTES),
          );
        },
        resize(cols, rows) {
          resizePty(masterFd, cols, rows);
        },
        kill(signal) {
          const selectedSignal = signal || "SIGTERM";
          try {
            process.kill(-child.pid!, selectedSignal);
          } catch {
            try {
              child.kill(selectedSignal);
            } catch {
              // The process has already exited.
            }
          }
        },
        onData(callback) {
          dataCallbacks.add(callback);
          return () => dataCallbacks.delete(callback);
        },
        onExit(callback) {
          exitCallbacks.add(callback);
          if (exitInfo) queueMicrotask(() => callback(exitInfo!));
          return () => exitCallbacks.delete(callback);
        },
      };
    } catch (error) {
      if (slaveFd !== undefined) fs.closeSync(slaveFd);
      native.symbols.close(masterFd);
      throw error;
    }
  },
};
