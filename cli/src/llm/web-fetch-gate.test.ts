import { describe, expect, test } from "bun:test";
import { NETWORK_DENIED_AUTO, NETWORK_DENIED_PLAN } from "./network-constants";
import { SSRF_DENIED_METADATA } from "./web-fetch-constants";
import { decideFetch } from "./web-fetch-gate";

const env = {
  apiUrl: "http://localhost:25001",
  lookup: async (h: string) => {
    if (h === "example.com") return ["93.184.216.34"];
    if (h === "localhost") return ["127.0.0.1"];
    return [h];
  },
};

test("auto denies public URL (plan 26)", async () => {
  const d = await decideFetch("auto", "WebFetch", { url: "https://example.com/doc" }, env);
  expect(d.action).toBe("deny");
  if (d.action === "deny") expect(d.message).toBe(NETWORK_DENIED_AUTO);
});

test("ask asks for public URL", async () => {
  const d = await decideFetch("ask", "mcp__chavez-web__fetch", { url: "https://example.com/doc" }, env);
  expect(d.action).toBe("ask");
});

test("plan denies", async () => {
  const d = await decideFetch("plan", "WebFetch", { url: "https://example.com/doc" }, env);
  expect(d.action).toBe("deny");
  if (d.action === "deny") {
    expect([NETWORK_DENIED_PLAN].includes(d.message) || d.message.includes("Plan mode")).toBe(true);
  }
});

test("SSRF wins before ask — user never sees metadata approval", async () => {
  const d = await decideFetch(
    "ask",
    "WebFetch",
    { url: "http://169.254.169.254/latest/meta-data" },
    env,
  );
  expect(d.action).toBe("deny");
  if (d.action === "deny") expect(d.message).toBe(SSRF_DENIED_METADATA);
});
