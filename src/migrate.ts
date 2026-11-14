import { readFile } from "node:fs/promises";
import { createPool } from "./db.js";

const db = createPool();
await db.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
await db.end();
console.log("schema is up to date");
