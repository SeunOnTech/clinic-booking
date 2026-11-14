const $ = (id) => document.getElementById(id);
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

let slots = [];
let chosen = null;
// One key per attempt to book, reused if the same attempt is sent again, so a double click or a retry after a
// dropped connection can't book twice.
let attemptKey = null;

async function request(method, path, body, headers = {}) {
  const res = await fetch(`/site${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const wait = res.headers.get("Retry-After");
    const message = res.status === 429 && wait ? `Too many tries. Wait ${wait} seconds and try again.` : data.error;
    throw new Error(message || "Something went wrong. Try again.");
  }
  return data;
}

function when(slot) {
  return `${day.format(new Date(slot.start))}, ${time.format(new Date(slot.start))} to ${time.format(new Date(slot.end))}`;
}

function show(section) {
  $("pick").hidden = section !== "pick";
  $("done").hidden = section !== "done";
}

async function loadSlots() {
  ({ slots } = await request("GET", "/slots"));
  const upcoming = slots.filter((s) => Date.parse(s.start) > Date.now());
  const box = $("slots");
  box.replaceChildren();
  if (upcoming.length === 0) {
    box.innerHTML = '<p class="muted">No appointments are open right now.</p>';
    return;
  }

  let current = "";
  let grid;
  for (const slot of upcoming) {
    const label = day.format(new Date(slot.start));
    if (label !== current) {
      current = label;
      const heading = document.createElement("h3");
      heading.textContent = label;
      grid = document.createElement("div");
      grid.className = "day";
      box.append(heading, grid);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slot";
    button.disabled = !slot.available;
    button.innerHTML = "<strong></strong><span></span>";
    button.querySelector("strong").textContent = time.format(new Date(slot.start));
    button.querySelector("span").textContent = slot.provider;
    button.addEventListener("click", () => choose(slot));
    grid.append(button);
  }
}

function choose(slot) {
  chosen = slot;
  attemptKey = crypto.randomUUID();
  $("chosen").textContent = `${slot.provider}, ${when(slot)}`;
  $("form-error").textContent = "";
  $("slots").hidden = true;
  $("form").hidden = false;
  $("form").elements.name.focus();
}

function backToSlots() {
  $("form").hidden = true;
  $("slots").hidden = false;
  return loadSlots();
}

function showBooking(booking) {
  const slot = slots.find((s) => s.id === booking.slot_id);
  $("done-title").textContent = booking.status === "confirmed" ? "You're booked" : "Booking cancelled";
  const rows = [
    ["With", slot?.provider],
    ["When", slot && when(slot)],
    ["Name", booking.name],
    ["Email", booking.email],
    ["Status", booking.status],
    ["Reference", booking.id],
  ];
  $("details").replaceChildren(
    ...rows
      .filter(([, v]) => v)
      .flatMap(([k, v]) => {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = k;
        dd.textContent = v;
        return [dt, dd];
      }),
  );
  $("cancel").hidden = booking.status !== "confirmed";
  $("cancel").dataset.id = booking.id;
  $("done-error").textContent = "";
  history.replaceState(null, "", `?booking=${encodeURIComponent(booking.id)}`);
  show("done");
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  $("form-error").textContent = "";
  try {
    const booking = await request(
      "POST",
      "/bookings",
      { slot_id: chosen.id, name: form.elements.name.value, email: form.elements.email.value },
      { "Idempotency-Key": attemptKey },
    );
    showBooking(booking);
  } catch (err) {
    // The same key with a changed name or email would be refused, so a corrected form is a new attempt.
    attemptKey = crypto.randomUUID();
    $("form-error").textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$("change").addEventListener("click", backToSlots);

$("cancel").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    showBooking(await request("DELETE", `/bookings/${encodeURIComponent(button.dataset.id)}`));
  } catch (err) {
    $("done-error").textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$("again").addEventListener("click", async () => {
  history.replaceState(null, "", location.pathname);
  $("form").reset();
  show("pick");
  await backToSlots();
});

async function start() {
  $("zone").textContent = `Times are shown in your time zone (${zone}).`;
  try {
    await loadSlots();
    const id = new URLSearchParams(location.search).get("booking");
    if (id) showBooking(await request("GET", `/bookings/${encodeURIComponent(id)}`));
  } catch (err) {
    $("slots").textContent = err.message;
  }
}

start();
