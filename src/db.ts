import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString, max: 5 });
}

export async function inTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("begin");
    const result = await work(tx);
    await tx.query("commit");
    return result;
  } catch (err) {
    await tx.query("rollback");
    throw err;
  } finally {
    tx.release();
  }
}

/** Serialises work on one key until the transaction ends. */
export async function lock(tx: Tx, key: string): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}
