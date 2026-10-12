export interface AgentInstallMetadata {endpoint:string;install_url:string;release_url:string;version:string;bundles:string[]}

export function agentInstallCommand(metadata:AgentInstallMetadata,endpoint:string,groupID:string):string {
 const base=endpoint.trim().replace(/\/+$/,''),quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
 return `curl -fSL ${quote(base+'/downloads/agent/install.sh')} -o lightmoni-install.sh\nsudo -v\nsystemd-ask-password 'LightMoni 上报 Key' | sudo -n sh lightmoni-install.sh --release-url ${quote(base+'/downloads/agent')} --version ${quote(metadata.version)} --endpoint ${quote(base)} --group-id ${quote(groupID)} --key-stdin`;
}
