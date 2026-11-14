// Local server. On Vercel, src/index.ts is the entry and public/ is served by the CDN.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import app from "../src/index.js";

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`http://localhost:${port}`));
