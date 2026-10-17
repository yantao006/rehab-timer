import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Real SQLite, including CHECK/UNIQUE/foreign-key failures and rollback, behind D1's API.
// No HTTP server or browser is started by these tests.
export class SQLiteD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(readFileSync(new URL('../../migrations/0001_shared_training.sql', import.meta.url), 'utf8'));
    this.beforeWrite = null; this.failStatement = null; this.queries = 0;
  }
  withSession() { return this; }
  prepare(sql) {
    const owner = this;
    return {
      sql, args: [],
      bind(...args) { return { ...this, args }; },
      async first(column) {
        owner.queries++;
        const value = owner.database.prepare(this.sql).get(...this.args);
        return value ? column ? value[column] : { ...value } : null;
      },
      async all() { return owner.run(this); },
      async run() { return owner.run(this); }
    };
  }
  run(statement) {
    this.queries++;
    if (this.failStatement?.(statement.sql)) throw new Error('injected-storage-error');
    const prepared = this.database.prepare(statement.sql);
    if (prepared.columns().length) return { success: true, results: prepared.all(...statement.args).map(row => ({ ...row })), meta: { changes: 0 } };
    const result = prepared.run(...statement.args);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async batch(statements) {
    if (statements[0]?.sql.startsWith('INSERT INTO write_guards') && this.beforeWrite) {
      const callback = this.beforeWrite; this.beforeWrite = null;
      await callback();
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => this.run(statement));
      this.database.exec('COMMIT'); return results;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  close() { this.database.close(); }
}
