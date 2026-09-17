import { describe, expect, test, afterAll } from "bun:test";
import { FETCH_BODY_MAX_CHARS, SSRF_DENIED_METADATA } from "./web-fetch-constants";
import { runWebFetch } from "./web-fetch-http";

const apiUrl = "http://127.0.0.1:25001";

function startServer(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return { server, origin };
}

describe("runWebFetch", () => {
  const servers: Array<{ stop: () => void }> = [];
  afterAll(() => {
    for (const s of servers) s.stop();
  });

  test("returns bounded text from HTML", async () => {
    const { server, origin } = startServer(
      () =>
        new Response("<html><body><h1>Docs</h1><p>Outside the repo</p></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    servers.push(server);
    const r = await runWebFetch(`${origin}/readme`, { apiUrl });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Docs");
    expect(r.text).toContain("Outside the repo");
    expect(r.text).not.toContain("<h1>");
    expect(r.truncated).toBe(false);
  });

  test("truncates huge text", async () => {
    const { server, origin } = startServer(
      () =>
        new Response("y".repeat(FETCH_BODY_MAX_CHARS + 80), {
          headers: { "content-type": "text/plain" },
        }),
    );
    servers.push(server);
    const r = await runWebFetch(`${origin}/big`, { apiUrl });
    expect(r.text).toContain("[truncated:");
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(FETCH_BODY_MAX_CHARS + 80);
  });

  test("omits binary", async () => {
    const { server, origin } = startServer(
      () =>
        new Response(new Uint8Array([0, 1, 2, 3]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    servers.push(server);
    const r = await runWebFetch(`${origin}/bin`, { apiUrl });
    expect(r.text.startsWith("binary content omitted")).toBe(true);
  });

  test("refuses redirect to metadata", async () => {
    const { server, origin } = startServer(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    );
    servers.push(server);
    const r = await runWebFetch(`${origin}/bounce`, { apiUrl });
    expect(r.ok).toBe(false);
    expect(r.text).toBe(SSRF_DENIED_METADATA);
  });

  test("does not follow redirect to API origin", async () => {
    const { server, origin } = startServer(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:25001/providers" },
        }),
    );
    servers.push(server);
    const r = await runWebFetch(`${origin}/to-api`, {
      apiUrl,
      lookup: async (h) => [h === "localhost" ? "127.0.0.1" : h],
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Chavez API origin");
  });
});
