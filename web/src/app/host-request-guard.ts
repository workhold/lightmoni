export type HostRequestScope='detail'|'check'|'terminal'|'uninstall'|'plan'|'update';
export type HostRequestToken={scope:HostRequestScope;generation:number;target:string};

/** A response belongs to the exact host selection that started it. */
export function createHostRequestGuard(){
 const selections=new Map<HostRequestScope,HostRequestToken>();
 const begin=(scope:HostRequestScope,target:string):HostRequestToken=>{
  const token={scope,target,generation:(selections.get(scope)?.generation??0)+1};
  selections.set(scope,token);return token;
 };
 return {
  begin,
  capture:(scope:HostRequestScope)=>selections.get(scope),
  current:(token:HostRequestToken|undefined)=>!!token&&selections.get(token.scope)===token&&!!token.target,
  close:(scope:HostRequestScope)=>{begin(scope,'')},
  invalidateHost:(id:string)=>{for(const [scope,token] of selections)if(token.target===id)begin(scope,id)},
  forget:(id:string)=>{for(const [scope,token] of selections)if(token.target===id)begin(scope,'')},
  clear:()=>{for(const scope of selections.keys())begin(scope,'')},
 };
}

/** Preserve the boundary between an IPv6 literal and its separate SSH port. */
export function sshEndpoint(address:string,port:number,username?:string){
 const host=address.includes(':')&&!address.startsWith('[')?`[${address}]`:address;
 return `${username?username+'@':''}${host}:${port}`;
}
