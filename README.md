# Clinic booking

An API for booking clinic appointment slots, and a web page that uses it. Built for the Koya Cohort 4 assessment,
to the spec at https://koyaacademy.com/assessment-api.

- API: https://clinic-booking-sepia.vercel.app/api (every request needs `X-API-Key`)
- Web page: https://clinic-booking-sepia.vercel.app

TypeScript, [Hono](https://hono.dev), Postgres. Hosted on Vercel with a Neon database.

## Run it

Needs Node 22+ and a Postgres database.

```sh
cp .env.example .env          # set DATABASE_URL and API_KEY (16+ characters)
npm install
npm run migrate               # creates the tables
npm run dev                   # http://localhost:3000
API_KEY=... npx tsx scripts/seed.ts   # a week of slots for two doctors
```

To run the spec's checks against a deployed copy (this resets its data):

```sh
API_URL=https://.../api API_KEY=... npx tsx scripts/check-live.ts
```

Tests run against a real Postgres (`TEST_DATABASE_URL`, default `postgres://postgres:local@localhost:55499/clinic`),
because the guarantees that matter here are the database's:

```sh
docker run -d -e POSTGRES_PASSWORD=local -e POSTGRES_DB=clinic -p 55499:5432 postgres:17-alpine
npm test
```

## How each level works

**1. Slots and bookings.** `POST /reset` replaces the slots and clears every booking. Slot times are returned exactly
as they were sent. Availability is worked out from bookings when slots are listed, so it can't drift.

**2. API key and validation.** A middleware checks `X-API-Key` on every `/api` route, including unknown ones, with a
constant-time comparison. Bookings are checked in the order the spec gives: missing fields and bad email (400), unknown
slot (404), started slot (400). Name and email are trimmed; email is stored in lower case.

**3. No double booking.** A partial unique index allows one `confirmed` booking per slot:

```sql
create unique index one_confirmed_booking_per_slot on bookings (slot_id) where status = 'confirmed';
```

The insert uses `on conflict ... do nothing`, so when requests race, Postgres lets exactly one through and the rest get 409. Checking first and inserting after would leave a gap between the two. Cancelling sets the status to `cancelled`,
which takes the booking out of the index and frees the slot.

**4. Retries and paging.** With an `Idempotency-Key`, the request takes a transaction-scoped advisory lock on the key,
looks for a saved response, and if there is none, books and saves the response in the same transaction. A retry gets
the saved status and body; two copies arriving together wait on the lock, so only one books. The body is compared by
hash after sorting its keys, so a reordered body counts as the same and a changed one gets 422. Error responses are
saved too, except 429, so a retry after the rate-limit window goes through. Listing by email uses a keyset cursor on
an insertion sequence, so pages don't skip or repeat rows when bookings are added between requests.

**5. Spam.** Five attempts per email in any 60 seconds (a sliding window), failed ones included, kept in Postgres so
every serverless instance shares the count. An advisory lock per email makes simultaneous attempts count one at a
time. The 6th gets 429 with `Retry-After` set to when the oldest attempt leaves the window. A replayed idempotent
request isn't a new attempt and doesn't count.

## The web page

`public/` is a plain HTML page with no build step; Vercel's CDN serves its files and the app serves `/`. It talks to `/site/*`, which runs the same booking code on the
server, so the API key never reaches the browser. Those routes refuse writes from other origins, and the per-email
limit applies to them too. Each booking attempt sends an `Idempotency-Key`, so a double click books once.

## Decisions and trade-offs

- **The database enforces the rules.** Double booking, idempotency and rate limiting all hold in Postgres rather than
  in process memory, because serverless instances share nothing and can run side by side.
- **The key stays on the server.** A page that sends the key from the browser would publish it.
- **Reset clears idempotency keys and attempt counts** along with bookings, since they refer to bookings that no longer
  exist.

## What I'd do next

- Expire idempotency keys and old attempt rows with a scheduled job (they're small, but they grow).
- An IP-based limit in front of the per-email one, since an attacker can vary the email.
- Email the patient a confirmation with a link to cancel, instead of showing the booking id.
- Structured logs with a request id, and an OpenAPI check in CI against the published spec.
