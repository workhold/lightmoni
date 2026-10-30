export type ConnectionCredential={
 id:string;name:string;method:'ssh_key'|'password';secret_fingerprint:string;
 retention:string;expires_at:string;status:'active'|'expired'|'revoked';
 hosts:{id:string;name:string}[];created_at:string;last_used_at:string;
 secret_cleared_at?:string;revoked_at?:string;reused?:boolean;
};
export const availableConnectionCredential=(credential:ConnectionCredential,now=Date.now())=>credential.status==='active'&&!credential.revoked_at&&!credential.secret_cleared_at&&(credential.retention==='permanent'?credential.expires_at==='':Number.isFinite(Date.parse(credential.expires_at))&&Date.parse(credential.expires_at)>now);
