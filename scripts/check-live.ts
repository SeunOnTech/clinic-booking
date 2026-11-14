// Runs the spec's checks for every level against a deployed API. It resets the data first.
// Usage: API_URL=https://.../api API_KEY=... npx tsx scripts/check-live.ts
import assert from "node:assert/strict";

const apiUrl = process.env.API_URL ?? "http://localhost:3000/api";
const key = process.env.API_KEY ?? "";

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${apiUrl}${path}`, {
    method,
    headers: { "X-API-Key": key, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString().replace(".000", "");
const slots = ["a", "b", "c", "d"].map((id, i) => ({
  id,
  provider: "Dr Ade",
  start: iso((i + 1) * 86_400_000),
  end: iso((i + 1) * 86_400_000 + 1_800_000),
}));
slots.push({ id: "old", provider: "Dr Ade", start: iso(-3_600_000), end: iso(-1_800_000) });

const check = async (name: string, fn: () => Promise<void>) => {
  await fn();
  console.log(`ok  ${name}`);
};

await check("401 without a key", async () => {
  assert.equal((await fetch(`${apiUrl}/slots`)).status, 401);
});
await check("reset and list", async () => {
  assert.equal((await call("POST", "/reset", { slots })).status, 200);
  const body = await (await call("GET", "/slots")).json();
  assert.deepEqual(
    body.slots.map((s: { id: string }) => s.id),
    ["old", "a", "b", "c", "d"],
  );
});
await check("validation", async () => {
  assert.equal((await call("POST", "/bookings", { slot_id: "a", name: "Ada", email: "bad" })).status, 400);
  assert.equal((await call("POST", "/bookings", { slot_id: "zz", name: "Ada", email: "v@example.com" })).status, 404);
  assert.equal((await call("POST", "/bookings", { slot_id: "old", name: "Ada", email: "w@example.com" })).status, 400);
});
await check("one winner among 30 simultaneous bookings", async () => {
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      call("POST", "/bookings", { slot_id: "a", name: "P", email: `p${i}@example.com` }),
    ),
  );
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 1, String(statuses));
  assert.equal(statuses.filter((s) => s === 409).length, 29, String(statuses));
});
await check("idempotent retries, 422 on a changed body", async () => {
  const body = { slot_id: "b", name: "Ada Obi", email: "ada@example.com" };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => call("POST", "/bookings", body, { "Idempotency-Key": "live-1" })),
  );
  const ids = new Set(await Promise.all(results.map(async (r) => (assert.equal(r.status, 201), (await r.json()).id))));
  assert.equal(ids.size, 1);
  const changed = await call("POST", "/bookings", { ...body, slot_id: "c" }, { "Idempotency-Key": "live-1" });
  assert.equal(changed.status, 422);
});
await check("cancel frees the slot", async () => {
  const booking = await (
    await call("POST", "/bookings", { slot_id: "c", name: "Bola", email: "bola@example.com" })
  ).json();
  assert.equal((await call("DELETE", `/bookings/${booking.id}`)).status, 200);
  assert.equal((await call("DELETE", `/bookings/${booking.id}`)).status, 409);
  assert.equal(
    (await call("POST", "/bookings", { slot_id: "c", name: "Bola", email: "bola@example.com" })).status,
    201,
  );
});
await check("paging", async () => {
  await call("POST", "/bookings", { slot_id: "d", name: "Ada Obi", email: "ADA@example.com" });
  const first = await (await call("GET", "/bookings?email=Ada@Example.com&limit=1")).json();
  assert.equal(first.bookings.length, 1);
  const second = await (
    await call("GET", `/bookings?email=ada@example.com&limit=1&cursor=${first.next_cursor}`)
  ).json();
  assert.equal(second.bookings.length, 1);
  assert.equal(second.next_cursor, null);
  assert.equal((await call("GET", "/bookings?email=ada@example.com&limit=51")).status, 400);
});
await check("rate limit", async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await call("POST", "/bookings", { slot_id: "zz", name: "S", email: "spam@example.com" })).status);
  }
  assert.deepEqual(statuses, [404, 404, 404, 404, 404, 429]);
  const limited = await call("POST", "/bookings", { slot_id: "zz", name: "S", email: "spam@example.com" });
  assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
  assert.equal((await call("POST", "/bookings", { slot_id: "zz", name: "S", email: "other@example.com" })).status, 404);
});
console.log("all checks passed");
