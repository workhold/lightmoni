import type { DB } from '../shared/types.js';

/** SSH-account storage baseline. Never migrate or destroy development secrets. */
export function initializeCenterSchema(db: DB): void {
  if (db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='center_schema'")) {
    if (db.get<{version: number}>('SELECT version FROM center_schema WHERE id=1')?.version !== 2)
      throw Error('Unsupported center database baseline; back up development data and use a new data directory for baseline 2.');
    return;
  }
  if (db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1"))
    throw Error('Pre-release center database is unsupported; back up development data and initialize a new data directory.');
  db.exec('CREATE TABLE center_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO center_schema VALUES(1,2);');
}
