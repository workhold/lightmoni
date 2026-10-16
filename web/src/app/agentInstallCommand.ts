import type {ReportingAddress} from './reporting-addresses';
export interface AgentInstallMetadata {endpoint:string;endpoints?:ReportingAddress[];default_endpoint_id?:string;install_url:string;release_url:string;version:string;bundles:string[];requires_key?:boolean}

export function agentInstallCommand(metadata:AgentInstallMetadata,endpoint:string,groupID:string,key:string):string {
 const base=endpoint.trim().replace(/\/+$/,''),secret=key.trim(),quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
 if(!secret||/[\r\n\0]/.test(secret))return '';
 return `(\n  LIGHTMONI_KEY=${quote(secret)}\n  curl -fSL --header "Authorization: Bearer $LIGHTMONI_KEY" ${quote(base+'/downloads/agent/install.sh')} -o lightmoni-install.sh &&\n  sudo -v &&\n  printf '%s\\n' "$LIGHTMONI_KEY" | sudo -n sh lightmoni-install.sh --release-url ${quote(base+'/downloads/agent')} --version ${quote(metadata.version)} --endpoint ${quote(base)} --group-id ${quote(groupID)} --key-stdin\n)`;
}
