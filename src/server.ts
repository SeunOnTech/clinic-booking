import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.js";
import { createPool } from "./db.js";

const app = createApp(createPool(), process.env.API_KEY ?? "");
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`http://localhost:${port}`));
