import { createApp } from "../src/app.js";
import { createPool } from "../src/db.js";

// One pool per function instance; Vercel reuses warm instances between requests.
const app = createApp(createPool(), process.env.API_KEY ?? "");

export default app;
