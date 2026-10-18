export interface SDKKey {id:string;name:string;active:boolean;allowed_tables:string[];allow_all_tables:boolean;last_used:string;upload_batches:number;error_count:number}
export interface CreatedSDKKey {id:string;name:string;key:string;allowed_tables:string[];allow_all_tables:boolean}
export interface SDKKeyValues {name:string;allowed_tables?:string[];allow_all_tables?:boolean}
export interface ExemptTable {name:string;description:string;active:boolean;created_at:string}
export interface ExemptTableValues {name:string;description?:string;active?:boolean}
export const sdkError=(error:unknown)=>error instanceof Error?error.message:'操作失败，请重试';
