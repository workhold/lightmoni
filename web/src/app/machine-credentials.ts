export type MachineCredentialState={method:string;retention?:string;expires_at?:string;revoked_at?:string;secret_cleared_at?:string};
export const permanentMachineCredential=(credential:MachineCredentialState)=>credential.retention==='permanent'&&credential.expires_at==='';
export const activeMachineCredential=(credential:MachineCredentialState,now=Date.now())=>!credential.revoked_at&&!credential.secret_cleared_at&&(credential.retention==='permanent'?permanentMachineCredential(credential):Number.isFinite(Date.parse(credential.expires_at||''))&&Date.parse(credential.expires_at||'')>now);
export const reusableMachineCredential=(credential:MachineCredentialState,now=Date.now())=>activeMachineCredential(credential,now)&&(credential.method==='ssh_key'||credential.method==='password'&&['temporary','managed','permanent'].includes(credential.retention||''));

// A recorded default is authoritative: an invalid default must not silently
// switch an operation to a different credential.
export function defaultMachineCredential<T extends MachineCredentialState&{id:string;is_default?:boolean}>(credentials:T[],defaultID?:string,predicate:(credential:T)=>boolean=activeMachineCredential):string|undefined{
 const recorded=defaultID||credentials.find(credential=>credential.is_default)?.id;
 if(recorded)return credentials.some(credential=>credential.id===recorded&&predicate(credential))?recorded:undefined;
 const active=credentials.filter(predicate);return active.length===1?active[0].id:undefined;
}
