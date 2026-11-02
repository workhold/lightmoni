import type {SSHCheckResult} from '../shared/SSHCheckSummary';
export type MachineCredentialState={method:string;retention?:string;expires_at?:string;revoked_at?:string;secret_cleared_at?:string};
export type SSHCredential=MachineCredentialState&{id:string;account_id:string;username:string;account_revision:number;name?:string;is_default?:boolean;secret_fingerprint?:string};
export type SSHAccount={id:string;machine_id:string;username:string;revision:number;default_credential_id:string;created_at:string;created_by:string;updated_at:string;credentials:SSHCredential[];last_check:SSHCheckResult|null;check_fresh:boolean;recommended:boolean;recommended_credential_id:string};
export type SSHAccountHost={default_account_id?:string;accounts?:SSHAccount[]};
export const sshCredentialLabel=(credential:{id:string;username:string;name?:string;secret_fingerprint?:string})=>`${credential.username} · ${credential.name||credential.id} · ${credential.secret_fingerprint||credential.id}`;
export const sshAccountPath=(machineID:string,accountID?:string)=>`/machines/${encodeURIComponent(machineID)}/accounts${accountID?'/'+encodeURIComponent(accountID):''}`;
export const permanentMachineCredential=(credential:MachineCredentialState)=>credential.retention==='permanent'&&credential.expires_at==='';
export const activeMachineCredential=(credential:MachineCredentialState,now=Date.now())=>!credential.revoked_at&&!credential.secret_cleared_at&&(credential.retention==='permanent'?permanentMachineCredential(credential):Number.isFinite(Date.parse(credential.expires_at||''))&&Date.parse(credential.expires_at||'')>now);
export const reusableMachineCredential=(credential:MachineCredentialState,now=Date.now())=>activeMachineCredential(credential,now)&&(credential.method==='ssh_key'||credential.method==='password'&&['temporary','managed','permanent'].includes(credential.retention||''));

// A recorded default is authoritative: an invalid default must not silently
// switch an operation to a different credential.
export function defaultMachineCredential<T extends MachineCredentialState&{id:string;account_id:string;username:string;account_revision:number}>(credentials:T[],host:SSHAccountHost|undefined,predicate:(credential:T)=>boolean=activeMachineCredential):string|undefined{
 const account=host?.accounts?.find(account=>account.id===host.default_account_id);
 if(!account?.default_credential_id)return;
 return credentials.some(credential=>credential.id===account.default_credential_id&&credential.account_id===account.id&&credential.username===account.username&&credential.account_revision===account.revision&&predicate(credential))?account.default_credential_id:undefined;
}

export const sshCheckMatchesCredential=(check:SSHCheckResult,machineID:string,credential:SSHCredential|undefined)=>!!credential&&check.machine_id===machineID&&check.credential_id===credential.id&&check.account_id===credential.account_id&&check.username===credential.username&&check.account_revision===credential.account_revision;
