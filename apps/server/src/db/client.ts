import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Database access wrapper. Every query against user-owned tables MUST run inside
 * `asUser` (sets `app.user_id` for row-level security) or `asSystem` (background
 * workers / auth bootstrap). Settings are transaction-local (`set_config(..., true)`).
 */
export class Db {
  readonly pool: pg.Pool;
  readonly orm: Database;

  constructor(connectionString: string, poolMax = 10) {
    this.pool = new pg.Pool({ connectionString, max: poolMax });
    this.orm = drizzle(this.pool, { schema });
  }

  asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.orm.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.user_id', ${userId}, true), set_config('app.system', 'off', true)`,
      );
      return fn(tx);
    });
  }

  asSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.orm.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.system', 'on', true), set_config('app.user_id', '', true)`,
      );
      return fn(tx);
    });
  }

  async ping(): Promise<void> {
    await this.pool.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { schema };
