/**
 * Fixed deployment map (context base 25000+):
 *   postgres = base+0 (25000)
 *   api      = base+1 (25001)
 *   web      = base+2 (25002)
 *   next…   = base+3, …
 * If 25xxx is busy, try 26000, 27000, … with the same offsets.
 */
export const STACK_BASE = 25000;
export const STACK_BASE_STEP = 1000;
export const STACK_BASE_MAX = 34000;

export const STACK_SERVICES = ["postgres", "api", "web"] as const;
export type StackService = (typeof STACK_SERVICES)[number];

/** Listeners started by this process (API only). */
export const LISTEN_SERVICES = ["api"] as const;

export function stackPort(
  service: StackService,
  base: number = STACK_BASE,
): number {
  const idx = STACK_SERVICES.indexOf(service);
  if (idx < 0) throw new Error(`Unknown stack service: ${service}`);
  return base + idx;
}

export const DEFAULT_API_PORT = stackPort("api");
export const DEFAULT_WEB_PORT = stackPort("web");
export const DEFAULT_POSTGRES_PORT = stackPort("postgres");

export function isPortFree(port: number): boolean {
  try {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve listen ports for API (and future in-process listeners).
 * - PORT env override → that port (must be free)
 * - else fixed stack base (25000): api = base+1, … — no silent fallback to 26001+
 *   (Web/CLI .env stay on 25001; jumping contexts would desync cookies/CORS)
 */
export function resolveListenPorts(
  count = LISTEN_SERVICES.length,
  portOverride?: number,
): number[] {
  if (count < 1) {
    throw new Error("portsNeeded must be >= 1");
  }

  if (portOverride !== undefined) {
    if (!isPortFree(portOverride)) {
      throw new Error(
        `PORT=${portOverride} is busy. Free it or set PORT / BETTER_AUTH_URL / PUBLIC_CHAVEZ_API_URL / CHAVEZ_API_URL to the same free port.`,
      );
    }
    return [portOverride];
  }

  const startIdx = STACK_SERVICES.indexOf("api");
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = STACK_BASE + startIdx + i;
    if (!isPortFree(p)) {
      throw new Error(
        `Port ${p} is busy (expected API stack ${STACK_BASE}+${startIdx}). Free it, or set PORT and align BETTER_AUTH_URL, PUBLIC_CHAVEZ_API_URL, CHAVEZ_API_URL, and WEB_ORIGIN. Silent fallback to ${STACK_BASE + STACK_BASE_STEP}+ is disabled so Web cookies/CORS stay in sync.`,
      );
    }
    ports.push(p);
  }
  return ports;
}

export function resolveAuthUrl(port: number, existing?: string): string {
  if (existing) {
    try {
      const u = new URL(existing);
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
        u.port = String(port);
        return u.toString().replace(/\/$/, "");
      }
      return existing.replace(/\/$/, "");
    } catch {
      // fall through to default
    }
  }
  return `http://localhost:${port}`;
}
