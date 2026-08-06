import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/**
 * PostgreSQL lifecycle.
 *
 * Replaces better-sqlite3, whose file lived on the container's disk and was
 * therefore lost on every redeploy and idle stop. A managed Postgres keeps a
 * submitted interview readable afterwards, which is the whole point of the
 * move.
 *
 * The cost is that `pg` is ASYNCHRONOUS where better-sqlite3 was not, so a
 * transaction is no longer an ordinary function call: it must hold ONE pinned
 * client for its whole duration. `transaction()` below is the only sanctioned
 * way to get one, precisely so no caller can interleave an unrelated await
 * between BEGIN and COMMIT.
 */

export class DatabaseError extends Error {
  public override readonly name = 'DatabaseError';
}

/** The subset of pg the repository uses — a pool, or a pinned client. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface DatabaseHandle extends Queryable {
  /**
   * Run `work` inside a single transaction on ONE pinned client.
   *
   * Commits on success, rolls back on any throw, and always releases the
   * client. The callback receives that client and MUST use it — issuing a
   * query against the pool instead would run OUTSIDE the transaction, which is
   * the classic way to silently lose atomicity after a port like this.
   */
  transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T>;
  readonly close: () => Promise<void>;
  /** Diagnostics only. Host and database — never the credentials. */
  readonly describe: string;
}

export interface OpenOptions {
  /** Postgres connection string. */
  readonly databaseUrl: string;
  /** Pool ceiling. Small by default: this is a low-write workload. */
  readonly maxConnections?: number;
}

/**
 * Host and database only — never the user, password or query string. This ends
 * up in startup logs, so it must not leak the credentials embedded in the URL.
 */
export function describeConnection(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return 'postgres';
  }
}

function assertConfigured(databaseUrl: string): void {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    throw new DatabaseError('DATABASE_URL is not configured');
  }
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl.trim())) {
    throw new DatabaseError('DATABASE_URL must be a postgres:// connection string');
  }
}

/**
 * Wrap a pg Pool as a DatabaseHandle.
 *
 * Exported so tests can supply a pg-mem-backed pool without a real server; the
 * production path goes through `openDatabase`.
 */
export function fromPool(pool: Pool, describe: string): DatabaseHandle {
  return {
    query: (sql, params) => pool.query(sql, params as unknown[]),

    async transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (err: unknown) {
        // Rollback must not mask the original failure: if the connection is
        // already broken the rollback throws too, and that secondary error is
        // far less useful than the one that actually happened.
        try {
          await client.query('ROLLBACK');
        } catch {
          // deliberately ignored
        }
        throw err;
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
    describe
  };
}

export function openDatabase(options: OpenOptions): DatabaseHandle {
  assertConfigured(options.databaseUrl);

  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: options.maxConnections ?? 5,
    // Managed Postgres (Neon and friends) requires TLS. `rejectUnauthorized`
    // is off because those providers terminate with certificates that do not
    // chain to a root present in the container image; the connection is still
    // encrypted.
    ssl: { rejectUnauthorized: false },
    // A free-tier database can be slow to wake. Fail with a clear error rather
    // than hanging a request forever.
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000
  });

  // A pool emits errors for IDLE clients too. With no handler, one dropped
  // backend connection takes the whole process down.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return fromPool(pool, describeConnection(options.databaseUrl));
}
