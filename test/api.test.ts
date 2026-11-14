import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPool } from "../src/db.js";

const KEY = "test-key-0123456789";
const db = createPool(process.env.TEST_DATABASE_URL ?? "postgres://postgres:local@localhost:55499/clinic");
db.options.max = 30;
const app = createApp(db, KEY);

const hour = 3600_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString().replace(".000", "");
const SLOTS = [
  { id: "s2", provider: "Dr Ade", start: at(48 * hour), end: at(48 * hour + 1800_000) },
  { id: "s1", provider: "Dr Ade", start: at(24 * hour), end: at(24 * hour + 1800_000) },
  { id: "s3", provider: "Dr Bisi", start: at(72 * hour), end: at(72 * hour + 1800_000) },
  { id: "past", provider: "Dr Bisi", start: at(-hour), end: at(-hour + 1800_000) },
];

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const book = (body: object, headers?: Record<string, string>) => call("POST", "/api/bookings", body, headers);
const ada = { slot_id: "s1", name: "Ada Obi", email: "ada@example.com" };

beforeAll(async () => {
  await db.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  expect((await call("POST", "/api/reset", { slots: SLOTS })).status).toBe(200);
});
afterAll(() => db.end());

describe("level 1", () => {
  it("lists slots earliest first, with availability, and filters by provider", async () => {
    const all = await (await call("GET", "/api/slots")).json();
    expect(all.slots.map((s: { id: string }) => s.id)).toEqual(["past", "s1", "s2", "s3"]);
    expect(all.slots[1]).toEqual({ ...SLOTS[1], available: true });

    const bisi = await (await call("GET", "/api/slots?provider=Dr%20Bisi")).json();
    expect(bisi.slots.map((s: { id: string }) => s.id)).toEqual(["past", "s3"]);
  });

  it("books a slot and looks the booking up", async () => {
    const res = await book(ada);
    expect(res.status).toBe(201);
    const booking = await res.json();
    expect(booking).toMatchObject({ ...ada, status: "confirmed" });
    expect(Date.parse(booking.created_at)).not.toBeNaN();

    expect(await (await call("GET", `/api/bookings/${booking.id}`)).json()).toEqual(booking);
    const slots = await (await call("GET", "/api/slots")).json();
    expect(slots.slots.find((s: { id: string }) => s.id === "s1").available).toBe(false);
  });

  it("returns 404 for an unknown booking", async () => {
    const res = await call("GET", "/api/bookings/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "booking not found" });
  });

  it("keeps bookings across requests and clears them on reset", async () => {
    const { id } = await (await book(ada)).json();
    await call("POST", "/api/reset", { slots: SLOTS });
    expect((await call("GET", `/api/bookings/${id}`)).status).toBe(404);
  });
});

describe("level 2", () => {
  it("refuses a missing or wrong API key on every endpoint", async () => {
    for (const [method, path] of [
      ["GET", "/api/slots"],
      ["POST", "/api/bookings"],
      ["POST", "/api/reset"],
      ["GET", "/api/bookings/x"],
      ["GET", "/api/anything"],
    ] as const) {
      expect((await app.request(path, { method })).status).toBe(401);
      expect((await app.request(path, { method, headers: { "X-API-Key": "wrong" } })).status).toBe(401);
    }
  });

  it.each([
    [{ name: "Ada", email: "ada@example.com" }, "slot_id is required"],
    [{ slot_id: "s1", name: "  ", email: "ada@example.com" }, "name is required"],
    [{ slot_id: "s1", name: "Ada" }, "email is required"],
    [{ slot_id: "s1", name: "Ada", email: "not-an-email" }, "email is not valid"],
    [{ slot_id: "s1", name: "Ada", email: "ada@example" }, "email is not valid"],
    [{ slot_id: 1, name: "Ada", email: "ada@example.com" }, "slot_id is required"],
  ])("turns away %j with 400", async (body, error) => {
    const res = await book(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it("returns 400 for a body that isn't JSON", async () => {
    const res = await app.request("/api/bookings", { method: "POST", headers: { "X-API-Key": KEY }, body: "{" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a slot that doesn't exist and 400 for one that has started", async () => {
    expect((await book({ ...ada, slot_id: "nope" })).status).toBe(404);
    const res = await book({ ...ada, slot_id: "past" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "slot has already started" });
  });

  it("trims name and email and stores the email in lower case", async () => {
    const res = await book({ slot_id: "s1", name: "  Ada Obi ", email: "  Ada@Example.COM " });
    expect(await res.json()).toMatchObject({ name: "Ada Obi", email: "ada@example.com" });
  });
});

describe("level 3", () => {
  it("gives a slot to exactly one of many simultaneous requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => book({ slot_id: "s2", name: `Patient ${i}`, email: `p${i}@example.com` })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(24);
    const { rows } = await db.query("select count(*)::int as n from bookings where slot_id = 's2'");
    expect(rows[0].n).toBe(1);
  });

  it("cancels a booking, frees the slot, and refuses a second cancel", async () => {
    const { id } = await (await book(ada)).json();
    expect((await book({ ...ada, email: "bola@example.com" })).status).toBe(409);

    const cancelled = await call("DELETE", `/api/bookings/${id}`);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ id, status: "cancelled" });

    expect((await book({ ...ada, email: "bola@example.com" })).status).toBe(201);
    expect((await call("DELETE", `/api/bookings/${id}`)).status).toBe(409);
    expect((await call("DELETE", "/api/bookings/nope")).status).toBe(404);
  });
});

describe("level 4", () => {
  it("returns the same response for a retried request and books once", async () => {
    const headers = { "Idempotency-Key": "retry-1" };
    const first = await book(ada, headers);
    const second = await book(ada, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    const { rows } = await db.query("select count(*)::int as n from bookings");
    expect(rows[0].n).toBe(1);
  });

  it("books once when the same key arrives many times at the same moment", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => book(ada, { "Idempotency-Key": "race" })));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    const ids = new Set(await Promise.all(results.map(async (r) => (await r.json()).id)));
    expect(ids.size).toBe(1);
  });

  it("replays an error response too", async () => {
    const headers = { "Idempotency-Key": "missing-slot" };
    expect((await book({ ...ada, slot_id: "nope" }, headers)).status).toBe(404);
    expect((await book({ ...ada, slot_id: "nope" }, headers)).status).toBe(404);
  });

  it("treats a reordered body as the same body", async () => {
    const headers = { "Idempotency-Key": "order" };
    const first = await (await book(ada, headers)).json();
    const second = await book({ email: ada.email, name: ada.name, slot_id: ada.slot_id }, headers);
    expect((await second.json()).id).toBe(first.id);
  });

  it("returns 422 when a key is reused with a different body", async () => {
    await book(ada, { "Idempotency-Key": "k" });
    const res = await book({ ...ada, slot_id: "s2" }, { "Idempotency-Key": "k" });
    expect(res.status).toBe(422);
  });

  it("pages through a person's bookings, oldest first, ignoring email case", async () => {
    for (const slot of ["s1", "s2", "s3"]) await book({ ...ada, slot_id: slot });
    await book({ slot_id: "s1", name: "Someone", email: "other@example.com" }); // 409, and not Ada's

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `/api/bookings?email=ADA@example.com&limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const page = await (await call("GET", query)).json();
      seen.push(...page.bookings.map((b: { slot_id: string }) => b.slot_id));
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(["s1", "s2", "s3"]);
    expect(pages).toBe(2);
  });

  it.each(["0", "51", "abc", "2.5", ""])("returns 400 for limit=%s", async (limit) => {
    expect((await call("GET", `/api/bookings?email=ada@example.com&limit=${limit}`)).status).toBe(400);
  });

  it("returns 400 without an email or with a bad cursor", async () => {
    expect((await call("GET", "/api/bookings")).status).toBe(400);
    expect((await call("GET", "/api/bookings?email=ada@example.com&cursor=%%%")).status).toBe(400);
  });
});

describe("level 5", () => {
  it("allows 5 attempts per email per minute, failed ones included, then 429 with Retry-After", async () => {
    const statuses = [];
    for (const slot of ["s1", "s1", "nope", "past", "s2"])
      statuses.push((await book({ ...ada, slot_id: slot })).status);
    expect(statuses).toEqual([201, 409, 404, 400, 201]);

    const limited = await book({ ...ada, slot_id: "s3" });
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(await limited.json()).toHaveProperty("error");
  });

  it("counts emails case-insensitively and leaves other emails alone", async () => {
    for (let i = 0; i < 5; i++) await book({ ...ada, slot_id: "nope", email: i % 2 ? "ADA@example.com" : ada.email });
    expect((await book({ ...ada, slot_id: "s3" })).status).toBe(429);
    expect((await book({ ...ada, slot_id: "s3", email: "bola@example.com" })).status).toBe(201);
  });

  it("holds under simultaneous attempts", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => book({ ...ada, slot_id: "nope" })));
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
  });
});

describe("web page endpoints", () => {
  it("book without the API key but refuse other sites", async () => {
    const ok = await app.request("/site/bookings", { method: "POST", body: JSON.stringify(ada) });
    expect(ok.status).toBe(201);
    const crossSite = await app.request("http://localhost/site/bookings", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: JSON.stringify({ ...ada, slot_id: "s2" }),
    });
    expect(crossSite.status).toBe(403);
  });
});
