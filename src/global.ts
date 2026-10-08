import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from './policy.ts';
import { Store } from './store.ts';
export class GlobalCoordinator {
  private db: DatabaseSync;
  private budgetStore?: Store;
  get budget(): Store {
    // Discovery/plan/status must not migrate or settle a preserved legacy ledger.
    // Paid accounting opens the same shared database only when it is needed.
    return (this.budgetStore ??= new Store(this.path));
  }
  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS leases (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, cap INTEGER NOT NULL);',
    );
  }
  async use<T>(limit: number, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 3)
      fail('GLOBAL_LIMIT', 'Global concurrency is bounded to three.');
    let id: number | undefined;
    while (id === undefined) {
      signal.throwIfAborted();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const rows = this.db.prepare('SELECT id,pid,cap FROM leases').all() as {
          id: number;
          pid: number;
          cap: number;
        }[];
        for (const row of rows) {
          try {
            process.kill(row.pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH')
              this.db.prepare('DELETE FROM leases WHERE id=?').run(row.id);
          }
        }
        const active = this.db.prepare('SELECT cap FROM leases').all() as { cap: number }[];
        if (active.length < Math.min(limit, ...active.map((l) => l.cap)))
          id = Number(
            this.db.prepare('INSERT INTO leases(pid,cap) VALUES (?,?)').run(process.pid, limit)
              .lastInsertRowid,
          );
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      if (id === undefined) await delay(50, undefined, { signal });
    }
    try {
      signal.throwIfAborted();
      return await fn();
    } finally {
      this.db.prepare('DELETE FROM leases WHERE id=?').run(id);
    }
  }
  close() {
    this.budgetStore?.close();
    this.db.close();
  }
}
export function openGlobalCoordinator() {
  // Operator state is outside per-repository data directories; requests cannot
  // choose a separate pool or bypass cumulative paid/UNKNOWN exposure.
  const directory = join(homedir(), '.local', 'state', 'council-forge');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, 'global.sqlite');
  const coordinator = new GlobalCoordinator(path);
  chmodSync(path, 0o600);
  return coordinator;
}
