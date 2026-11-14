import type { Hono } from "hono";
import { createPool } from "./db.js";
import { createApp } from "./http.js";

// Vercel runs this default export; warm instances keep the pool between requests.
const app: Hono = createApp(createPool(), process.env.API_KEY ?? "");

export default app;
