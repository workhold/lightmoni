import type { DB } from '../shared/types.js';

/** First public storage baseline. Development databases are rebuilt explicitly. */
export function initializeCenterSchema(db: DB): void {
  if (db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='center_schema'")) {
    if (db.get<{version: number}>('SELECT version FROM center_schema WHERE id=1')?.version !== 1)
      throw Error('Unsupported center database baseline; use a new data directory after backing up development data.');
    return;
  }
  if (db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1"))
    throw Error('Pre-release center database is unsupported; back up development data and initialize a new data directory.');
  db.exec('CREATE TABLE center_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO center_schema VALUES(1,1);');
}
