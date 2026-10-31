export interface ReportingAddress {id:string;name:string;url:string;scope?:'internal'|'public'}
export interface ReportingSettings {endpoint:string;default_endpoint:string;effective_endpoint:string;endpoints:ReportingAddress[];default_endpoint_id:string}
