import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { NETWORK_DENIED_RUNTIME } from "./network-constants";

export type SandboxBackend = "bwrap" | "unshare" | "seatbelt" | "none";

export type WrapOpts = {
  cwd: string;
  network: boolean;
  command: string;
};

export type SpawnFn = (
  cmd: string[],
  opts: { cwd: string; stdout: "pipe"; stderr: "pipe" },
) => {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
};

function which(bin: string): string | null {
  const dirs = (process.env.PATH || "").split(delimiter);
  for (const d of dirs) {
    const p = `${d}/${bin}`;
    if (existsSync(p)) return p;
  }
  return null;
}

export function detectSandboxBackend(): SandboxBackend {
  if (process.platform === "linux") {
    if (which("bwrap")) return "bwrap";
    if (which("unshare")) return "unshare";
    return "none";
  }
  if (process.platform === "darwin" && which("sandbox-exec")) {
    return "seatbelt";
  }
  return "none";
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function linuxBinds(cwd: string, network: boolean): string[] {
  // No bind de /etc completo: defensa en profundidad contra cat /etc/passwd.
  // DNS (resolv.conf) solo importa con network=true; ahí el gate Chavez ya aprobó.
  const ro = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
  const args: string[] = [];
  for (const p of ro) {
    if (existsSync(p)) args.push("--ro-bind", p, p);
  }
  // tmpfs /tmp antes del bind: si cwd está bajo /tmp, un tmpfs posterior lo ocultaría.
  args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
  args.push("--bind", cwd, cwd, "--chdir", cwd);
  args.push("--die-with-parent");
  if (!network) args.unshift("--unshare-net");
  return args;
}

function seatbeltProfile(cwd: string, network: boolean): string {
  const net = network
    ? "(allow network*)"
    : "(deny network*)\n(deny network-outbound)\n(deny network-inbound)";
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal)
(allow sysctl-read)
(allow file-read* (subpath "${cwd}") (subpath "/usr") (subpath "/bin") (subpath "/opt") (subpath "/Library") (subpath "/System") (subpath "/private/etc") (subpath "/dev") (subpath "/tmp"))
(allow file-write* (subpath "${cwd}") (subpath "/tmp") (subpath "/dev"))
(allow file-ioctl (subpath "/dev"))
${net}
`;
}

/**
 * argv que hay que spawnear. `none` → `["bash","-lc", command]` en cwd
 * (la política de Task 1 sigue siendo el hard gate; Windows cae aquí).
 */
export function wrapArgv(
  opts: WrapOpts,
  backend = detectSandboxBackend(),
): string[] {
  const { cwd, network, command } = opts;
  if (backend === "bwrap") {
    return [
      "bwrap",
      ...linuxBinds(cwd, network),
      "--",
      "/bin/bash",
      "-lc",
      command,
    ];
  }
  if (backend === "unshare") {
    const ns = network ? [] : ["--net"];
    return [
      "unshare",
      ...ns,
      "--map-root-user",
      "--fork",
      "/bin/bash",
      "-lc",
      `cd ${shQuote(cwd)} && ${command}`,
    ];
  }
  if (backend === "seatbelt") {
    return [
      "sandbox-exec",
      "-p",
      seatbeltProfile(cwd, network),
      "/bin/bash",
      "-lc",
      `cd ${shQuote(cwd)} && ${command}`,
    ];
  }
  return ["/bin/bash", "-lc", command];
}

/**
 * Prefijo inyectable en Bash.command vía updatedInput.
 * El SDK ejecuta este string con su propio bash -lc; por eso devolvemos
 * una línea que re-exec el wrap (no un argv).
 */
export function wrapCommandString(
  opts: WrapOpts,
  backend = detectSandboxBackend(),
): string {
  const argv = wrapArgv(opts, backend);
  return argv.map(shQuote).join(" ");
}

export async function runSandboxedBash(
  opts: WrapOpts,
  spawn: SpawnFn = ((cmd, o) =>
    Bun.spawn(cmd, o) as unknown as ReturnType<SpawnFn>),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const argv = wrapArgv(opts);
  const proc = spawn(argv, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function annotateNetworkFailure(stderr: string, stdout: string): string {
  const body = (stderr || stdout || "").trim();
  if (!body) return NETWORK_DENIED_RUNTIME;
  if (/network denied by workspace sandbox/i.test(body)) return body;
  return `${NETWORK_DENIED_RUNTIME}\n${body}`;
}
