export class ApiError extends Error{constructor(message:string,public status:number,public details:Record<string,unknown>){super(message);this.name='ApiError';}}
export async function api<T>(path:string, init:RequestInit = {}):Promise<T> {
 const url=path.startsWith('/api/')?path:`/api/v1${path.startsWith('/')?path:`/${path}`}`;
 const response=await fetch(url,{...init,credentials:'include',headers:{...(init.body?{'Content-Type':'application/json'}:{}),...init.headers}});
 const body=await response.json().catch(()=>({error:`HTTP ${response.status}`}));
 if(!response.ok) throw new ApiError(body.error??`HTTP ${response.status}`,response.status,body);
 return body as T;
}
export const post = <T>(path:string,body:unknown,signal?:AbortSignal)=>api<T>(path,{method:'POST',body:JSON.stringify(body),signal});
