create table if not exists slots (
  id         text primary key,
  provider   text not null,
  start_at   timestamptz not null,
  end_at     timestamptz not null,
  -- Returned exactly as they were sent to /reset.
  start_text text not null,
  end_text   text not null
);
create index if not exists slots_by_start on slots (start_at, id);

create table if not exists bookings (
  seq          bigint generated always as identity unique,
  id           text primary key,
  slot_id      text not null references slots (id) on delete cascade,
  name         text not null,
  email        text not null,
  status       text not null check (status in ('confirmed', 'cancelled')),
  created_at   timestamptz not null default clock_timestamp(),
  cancelled_at timestamptz
);
-- The double-booking guard: Postgres refuses a second confirmed booking for a slot, however many requests race.
create unique index if not exists one_confirmed_booking_per_slot on bookings (slot_id) where status = 'confirmed';
create index if not exists bookings_by_email on bookings (email, seq);

create table if not exists idempotency_keys (
  key          text primary key,
  request_hash text not null,
  status_code  int not null,
  body         jsonb not null,
  created_at   timestamptz not null default now()
);

create table if not exists booking_attempts (
  email text not null,
  at    timestamptz not null default clock_timestamp()
);
create index if not exists booking_attempts_by_email on booking_attempts (email, at);
