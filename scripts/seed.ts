// Fills a running API with a week of half-hour slots for two doctors, starting tomorrow.
// Usage: API_URL=https://.../api API_KEY=... npx tsx scripts/seed.ts
const apiUrl = process.env.API_URL ?? "http://localhost:3000/api";
const apiKey = process.env.API_KEY ?? "";

const slots = [];
const providers = ["Dr Ade Bello", "Dr Ngozi Eze"];
for (let d = 1; d <= 7; d++) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + d);
  if (date.getUTCDay() === 0) continue; // closed on Sundays
  for (const [p, provider] of providers.entries()) {
    for (let hour = 8 + p; hour < 12 + p; hour++) {
      for (const minute of [0, 30]) {
        const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute));
        const end = new Date(start.getTime() + 30 * 60_000);
        const iso = (t: Date) => t.toISOString().replace(".000", "");
        slots.push({
          id: `${provider.split(" ")[2]?.toLowerCase()}-${iso(start)}`,
          provider,
          start: iso(start),
          end: iso(end),
        });
      }
    }
  }
}

const res = await fetch(`${apiUrl}/reset`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
  body: JSON.stringify({ slots }),
});
console.log(res.status, await res.text());
