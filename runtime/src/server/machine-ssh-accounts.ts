import { fail } from '../shared/http.js';
import type { DB } from '../shared/sqlite.js';
import type { SSHCheckResult } from './managed-machines.js';

export interface MachineSSHAccount {
  id:string; machine_id:string; username:string; revision:number; default_credential_id:string;
  created_at:string; created_by:string; updated_at:string; credentials:Record<string,any>[];
  last_check:SSHCheckResult|null; check_fresh:boolean; recommended:boolean; recommended_credential_id:string;
}
export interface InstallationSSHAttempt {check_id:string;credential_id:string;account_id:string;username:string;account_revision:number;connected:boolean;ready:boolean;error_code:string;privilege_state:string;checked_at:string}
export interface InstallationSSHSelection {id:string;mode:'auto'|'manual';selected_credential_id:string;attempts:InstallationSSHAttempt[]}
export function createMachineSSHAccountsSchema(db:DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS machine_ssh_accounts(
    id TEXT PRIMARY KEY,machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,
    username TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),default_credential_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,created_by TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS machine_ssh_accounts_live_username ON machine_ssh_accounts(machine_id,username) WHERE deleted_at='';
  CREATE INDEX IF NOT EXISTS machine_ssh_accounts_machine ON machine_ssh_accounts(machine_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS machine_ssh_account_events(
    id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,account_id TEXT NOT NULL,event TEXT NOT NULL,actor_id TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS machine_ssh_account_events_account ON machine_ssh_account_events(account_id,created_at);`);
  db.exec(`CREATE TABLE IF NOT EXISTS machine_installation_selections(
    id TEXT PRIMARY KEY,machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,mode TEXT NOT NULL,
    status TEXT NOT NULL,selected_credential_id TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS machine_installation_selection_attempts(
    id TEXT PRIMARY KEY,selection_id TEXT NOT NULL REFERENCES machine_installation_selections(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,credential_id TEXT NOT NULL,account_id TEXT NOT NULL,username TEXT NOT NULL,account_revision INTEGER NOT NULL,
    status TEXT NOT NULL,check_id TEXT NOT NULL DEFAULT '',result_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,finished_at TEXT NOT NULL DEFAULT '',UNIQUE(selection_id,ordinal)
  );`);
}
export function validateSSHUsername(value:unknown):string {
  if(typeof value!=='string'||! /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value))fail(400,'invalid username');
  return value;
}
