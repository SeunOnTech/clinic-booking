import { inTransaction, type Db } from "./db.js";
import { HttpError } from "./errors.js";

export interface Slot {
  id: string;
  provider: string;
  start: string;
  end: string;
}

export interface SlotWithAvailability extends Slot {
  available: boolean;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseDateTime(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `slots[${index}].${field} must be an ISO 8601 date-time`);
  }
  return value;
}

function parseSlots(body: unknown): Slot[] {
  const slots = (body as { slots?: unknown } | null)?.slots;
  if (!Array.isArray(slots)) throw new HttpError(400, "slots must be an array");

  const seen = new Set<string>();
  return slots.map((raw: unknown, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    if (typeof s.id !== "string" || s.id.trim() === "") throw new HttpError(400, `slots[${i}].id is required`);
    if (seen.has(s.id)) throw new HttpError(400, `slot id ${s.id} appears more than once`);
    seen.add(s.id);
    if (typeof s.provider !== "string" || s.provider.trim() === "") {
      throw new HttpError(400, `slots[${i}].provider is required`);
    }
    const start = parseDateTime(s.start, "start", i);
    const end = parseDateTime(s.end, "end", i);
    if (Date.parse(end) <= Date.parse(start)) throw new HttpError(400, `slots[${i}].end must be after start`);
    return { id: s.id, provider: s.provider, start, end };
  });
}

/** Deletes every booking (and the idempotency and rate-limit records that go with them) and replaces all slots. */
export async function resetSlots(db: Db, body: unknown): Promise<{ slots: number }> {
  const slots = parseSlots(body);
  await inTransaction(db, async (tx) => {
    await tx.query("truncate booking_attempts, idempotency_keys, bookings, slots");
    if (slots.length > 0) {
      await tx.query(
        `insert into slots (id, provider, start_at, end_at, start_text, end_text)
         select id, provider, start_text::timestamptz, end_text::timestamptz, start_text, end_text
         from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as s (id, provider, start_text, end_text)`,
        [slots.map((s) => s.id), slots.map((s) => s.provider), slots.map((s) => s.start), slots.map((s) => s.end)],
      );
    }
  });
  return { slots: slots.length };
}

export async function listSlots(db: Db, provider?: string): Promise<SlotWithAvailability[]> {
  const { rows } = await db.query(
    `select s.id, s.provider, s.start_text as start, s.end_text as end,
            not exists (select 1 from bookings b where b.slot_id = s.id and b.status = 'confirmed') as available
     from slots s
     where $1::text is null or s.provider = $1
     order by s.start_at, s.id`,
    [provider ?? null],
  );
  return rows;
}
