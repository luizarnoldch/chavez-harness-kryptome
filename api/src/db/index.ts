import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "../lib/config";

const client = postgres(env.server.databaseUrl);
export const db = drizzle(client, { schema });
