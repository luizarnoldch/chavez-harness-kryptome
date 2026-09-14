import { Hono } from "hono";
import { swaggerUI } from "@hono/swagger-ui";
import { parse } from "yaml";

const yamlText = await Bun.file(
  new URL("../openapi/openapi.yaml", import.meta.url),
).text();

const openApiDocument = parse(yamlText) as Record<string, unknown>;

export const openApiRoutes = new Hono()
  .get("/openapi.json", (c) => c.json(openApiDocument))
  .get("/docs", swaggerUI({ url: "/openapi.json" }));
