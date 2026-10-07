import { DatabaseSync } from 'node:sqlite';
import { fail } from './policy.ts';
export class Store {
  private db: DatabaseSync;
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);`);
  }
  recover() {
    this.db.exec(
      "UPDATE runs SET state='interrupted' WHERE state='running'; UPDATE calls SET state='unknown' WHERE state='reserved';",
    );
  }
  begin(id: string, hash: string) {
    const previous = this.get(id);
    if (previous) {
      if (previous.hash !== hash)
        fail('IDEMPOTENCY_CONFLICT', 'Run ID already belongs to a different request.');
      return previous;
    }
    this.db.prepare('INSERT INTO runs (id,hash,state) VALUES (?,?,?)').run(id, hash, 'running');
    return null;
  }
  get(id: string) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as
      | { id: string; hash: string; state: string; result: string | null }
      | undefined;
    return row ? { ...row, result: row.result ? (JSON.parse(row.result) as unknown) : null } : null;
  }
  finish(id: string, state: string, result: unknown) {
    this.db
      .prepare('UPDATE runs SET state=?,result=? WHERE id=?')
      .run(state, JSON.stringify(result), id);
  }
  event(id: string, type: string, data: unknown) {
    this.db
      .prepare('INSERT INTO events (run_id,at,type,data) VALUES (?,?,?,?)')
      .run(id, new Date().toISOString(), type, JSON.stringify(data));
  }
  events(id: string) {
    return this.db
      .prepare('SELECT seq,at,type,data FROM events WHERE run_id=? ORDER BY seq')
      .all(id);
  }
  exposure(runId?: string): number {
    const sql =
      'SELECT COALESCE(SUM(COALESCE(charged,reserved)),0) AS total FROM calls' +
      (runId ? ' WHERE run_id=?' : '');
    const row = (runId ? this.db.prepare(sql).get(runId) : this.db.prepare(sql).get()) as {
      total: number;
    };
    return Number(row.total);
  }
  reserve(id: string, runId: string, amount: number, runLimit: number, globalLimit: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT id FROM calls WHERE id=?').get(id))
        fail(
          'CALL_ALREADY_EXISTS',
          'A dispatched or uncertain call is never automatically repeated.',
        );
      if (this.exposure(runId) + amount > runLimit || this.exposure() + amount > globalLimit)
        fail('BUDGET_EXHAUSTED', 'Reservation would exceed a configured API admission limit.');
      this.db.prepare('INSERT INTO calls VALUES (?,?,?,NULL,?)').run(id, runId, amount, 'reserved');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  settle(id: string, charged: number | null) {
    if (charged !== null && (!Number.isSafeInteger(charged) || charged < 0))
      fail('INVALID_COST', 'Invalid provider usage receipt.');
    const row = this.db.prepare('SELECT reserved FROM calls WHERE id=?').get(id) as
      | { reserved: number }
      | undefined;
    if (!row) fail('UNRESERVED_CALL', 'Cannot settle an unreserved API call.');
    this.db
      .prepare('UPDATE calls SET charged=?,state=? WHERE id=?')
      .run(charged, charged === null ? 'unknown' : 'settled', id);
    if (charged !== null && charged > row!.reserved)
      fail(
        'COST_OVERRUN',
        'Reported provider cost exceeded the admission estimate. The run is stopped.',
      );
  }
  close() {
    this.db.close();
  }
}
