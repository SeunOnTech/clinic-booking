import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cancelBooking, createBooking, getBooking, listBookings, type Reply } from "./bookings.js";
import type { Db } from "./db.js";
import { HttpError } from "./errors.js";
import { listSlots, resetSlots } from "./slots.js";

function sameKey(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, "body must be valid JSON");
  }
}

function send(c: Context, reply: Reply) {
  return c.json(reply.body, reply.status as ContentfulStatusCode, reply.headers);
}

const limitBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: () => {
    throw new HttpError(413, "request body is too large");
  },
});

/** The API in the spec. Every request needs the X-API-Key header. */
function api(db: Db, apiKey: string) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!sameKey(c.req.header("X-API-Key"), apiKey)) throw new HttpError(401, "missing or invalid API key");
    await next();
  });
  app.use("*", limitBody);

  app.post("/reset", async (c) => c.json(await resetSlots(db, await readJson(c))));
  app.get("/slots", async (c) => c.json({ slots: await listSlots(db, c.req.query("provider")) }));
  app.post("/bookings", async (c) =>
    send(c, await createBooking(db, await readJson(c), c.req.header("Idempotency-Key"))),
  );
  app.get("/bookings", async (c) => c.json(await listBookings(db, c.req.query())));
  app.get("/bookings/:id", async (c) => c.json(await getBooking(db, c.req.param("id"))));
  app.delete("/bookings/:id", async (c) => c.json(await cancelBooking(db, c.req.param("id"))));

  return app;
}

/**
 * What the web page calls. It runs the same code as the API but lives on the server, so the API key never reaches
 * the browser. Writes are accepted only from this site's own pages; the per-email rate limit still applies.
 */
function site(db: Db) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (c.req.method !== "GET" && origin !== undefined && new URL(origin).host !== new URL(c.req.url).host) {
      throw new HttpError(403, "cross-site request refused");
    }
    await next();
  });
  app.use("*", limitBody);

  app.get("/slots", async (c) => c.json({ slots: await listSlots(db) }));
  app.post("/bookings", async (c) =>
    send(c, await createBooking(db, await readJson(c), c.req.header("Idempotency-Key"))),
  );
  app.get("/bookings/:id", async (c) => c.json(await getBooking(db, c.req.param("id"))));
  app.delete("/bookings/:id", async (c) => c.json(await cancelBooking(db, c.req.param("id"))));

  return app;
}

export function createApp(db: Db, apiKey: string) {
  if (apiKey.length < 16) throw new Error("API_KEY must be at least 16 characters");

  const app = new Hono();
  // Vercel's CDN serves the rest of public/, but sends "/" to this function.
  let page: Promise<string> | undefined;
  app.get("/", async (c) =>
    c.html(await (page ??= readFile(new URL("../public/index.html", import.meta.url), "utf8"))),
  );
  app.route("/api", api(db, apiKey));
  app.route("/site", site(db));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status, err.headers);
    console.error(err);
    return c.json({ error: "something went wrong" }, 500);
  });
  return app;
}
