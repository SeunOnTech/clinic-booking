import { createHash, randomUUID } from "node:crypto";
import { inTransaction, lock, type Db, type Tx } from "./db.js";
import { HttpError } from "./errors.js";

export interface Booking {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  created_at: string;
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const RATE_LIMIT = { attempts: 5, windowSeconds: 60 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BOOKING_COLUMNS = "id, slot_id, name, email, status, created_at";

function toBooking(row: Record<string, unknown>): Booking {
  return {
    id: row.id as string,
    slot_id: row.slot_id as string,
    name: row.name as string,
    email: row.email as string,
    status: row.status as Booking["status"],
    created_at: (row.created_at as Date).toISOString(),
  };
}

function fail(err: HttpError): Reply {
  return { status: err.status, body: { error: err.message }, headers: err.headers };
}

/** The same JSON value always gives the same text, whatever order its keys came in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function emailOf(body: unknown): string | null {
  const email = (body as { email?: unknown } | null)?.email;
  return typeof email === "string" && email.trim() !== "" ? email.trim().toLowerCase() : null;
}

/**
 * Sliding one-minute window per email. Every attempt counts, whatever its outcome, except one turned away here,
 * so a client that waits Retry-After seconds always gets through.
 */
async function checkRateLimit(tx: Tx, email: string): Promise<void> {
  await lock(tx, `attempts:${email}`);
  const window = `${RATE_LIMIT.windowSeconds} seconds`;
  await tx.query("delete from booking_attempts where email = $1 and at <= clock_timestamp() - $2::interval", [
    email,
    window,
  ]);
  const { rows } = await tx.query(
    `select count(*)::int as attempts,
            ceil(extract(epoch from min(at) + $2::interval - clock_timestamp()))::int as retry_after
     from booking_attempts where email = $1`,
    [email, window],
  );
  const { attempts, retry_after } = rows[0];
  if (attempts >= RATE_LIMIT.attempts) {
    throw new HttpError(429, "too many booking attempts for this email, try again later", {
      "Retry-After": String(Math.max(1, retry_after)),
    });
  }
  await tx.query("insert into booking_attempts (email) values ($1)", [email]);
}

function parseNewBooking(body: unknown): { slotId: string; name: string; email: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  const { slot_id, name, email } = body as Record<string, unknown>;
  for (const [field, value] of Object.entries({ slot_id, name, email })) {
    if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${field} is required`);
  }
  const cleanEmail = (email as string).trim().toLowerCase();
  if (cleanEmail.length > 254 || !EMAIL.test(cleanEmail)) throw new HttpError(400, "email is not valid");
  const cleanName = (name as string).trim();
  if (cleanName.length > 200) throw new HttpError(400, "name is too long");
  return { slotId: slot_id as string, name: cleanName, email: cleanEmail };
}

async function book(tx: Tx, body: unknown): Promise<Reply> {
  const { slotId, name, email } = parseNewBooking(body);

  const slot = await tx.query("select start_at <= clock_timestamp() as started from slots where id = $1", [slotId]);
  if (slot.rowCount === 0) throw new HttpError(404, "slot not found");
  if (slot.rows[0].started) throw new HttpError(400, "slot has already started");

  // If another request holds or has taken this slot, the unique index makes this insert do nothing.
  const inserted = await tx.query(
    `insert into bookings (id, slot_id, name, email, status) values ($1, $2, $3, $4, 'confirmed')
     on conflict (slot_id) where status = 'confirmed' do nothing
     returning ${BOOKING_COLUMNS}`,
    [randomUUID(), slotId, name, email],
  );
  if (inserted.rowCount === 0) throw new HttpError(409, "slot is already booked");
  return { status: 201, body: toBooking(inserted.rows[0]) };
}

export async function createBooking(db: Db, body: unknown, idempotencyKey?: string): Promise<Reply> {
  if (idempotencyKey !== undefined && (idempotencyKey.length === 0 || idempotencyKey.length > 255)) {
    return fail(new HttpError(400, "Idempotency-Key must be 1 to 255 characters"));
  }
  const requestHash = createHash("sha256").update(canonical(body)).digest("hex");

  return inTransaction(db, async (tx) => {
    if (idempotencyKey !== undefined) {
      await lock(tx, `idempotency:${idempotencyKey}`);
      const saved = await tx.query("select request_hash, status_code, body from idempotency_keys where key = $1", [
        idempotencyKey,
      ]);
      if (saved.rowCount) {
        const { request_hash, status_code, body: savedBody } = saved.rows[0];
        if (request_hash !== requestHash) {
          return fail(new HttpError(422, "Idempotency-Key was already used with a different request body"));
        }
        // A replay is the same attempt seen again, so it doesn't count against the rate limit.
        return { status: status_code, body: savedBody };
      }
    }

    let reply: Reply;
    const email = emailOf(body);
    try {
      if (email) await checkRateLimit(tx, email);
    } catch (err) {
      // Not saved under the idempotency key: once the window passes, the same retry should go through.
      if (err instanceof HttpError) return fail(err);
      throw err;
    }
    try {
      reply = await book(tx, body);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      reply = fail(err);
    }

    if (idempotencyKey !== undefined) {
      await tx.query("insert into idempotency_keys (key, request_hash, status_code, body) values ($1, $2, $3, $4)", [
        idempotencyKey,
        requestHash,
        reply.status,
        JSON.stringify(reply.body),
      ]);
    }
    return reply;
  });
}

export async function getBooking(db: Db, id: string): Promise<Booking> {
  const { rows } = await db.query(`select ${BOOKING_COLUMNS} from bookings where id = $1`, [id]);
  if (rows.length === 0) throw new HttpError(404, "booking not found");
  return toBooking(rows[0]);
}

export async function cancelBooking(db: Db, id: string): Promise<Booking> {
  const { rows } = await db.query(
    `update bookings set status = 'cancelled', cancelled_at = clock_timestamp()
     where id = $1 and status = 'confirmed'
     returning ${BOOKING_COLUMNS}`,
    [id],
  );
  if (rows.length > 0) return toBooking(rows[0]);
  await getBooking(db, id); // 404 if it doesn't exist
  throw new HttpError(409, "booking is already cancelled");
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 10;
  const limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= 50)) throw new HttpError(400, "limit must be a whole number from 1 to 50");
  return limit;
}

// The cursor is the position of the last booking returned; it's opaque to clients so it can change later.
function decodeCursor(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const decoded = /^[A-Za-z0-9_-]+$/.test(raw) ? Buffer.from(raw, "base64url").toString("utf8") : "";
  const seq = /^\d+$/.test(decoded) ? Number(decoded) : NaN;
  if (!Number.isSafeInteger(seq)) throw new HttpError(400, "cursor is not valid");
  return seq;
}

export async function listBookings(
  db: Db,
  query: { email?: string; limit?: string; cursor?: string },
): Promise<{ bookings: Booking[]; next_cursor: string | null }> {
  const email = query.email?.trim().toLowerCase();
  if (!email) throw new HttpError(400, "email is required");
  const limit = parseLimit(query.limit);
  const after = decodeCursor(query.cursor);

  const { rows } = await db.query(
    `select seq, ${BOOKING_COLUMNS} from bookings where email = $1 and seq > $2 order by seq limit $3`,
    [email, after, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const next_cursor = rows.length > limit && last ? Buffer.from(String(last.seq)).toString("base64url") : null;
  return { bookings: page.map(toBooking), next_cursor };
}
