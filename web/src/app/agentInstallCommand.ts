import type {ReportingAddress} from './reporting-addresses';
export interface AgentInstallMetadata {endpoint:string;endpoints?:ReportingAddress[];default_endpoint_id?:string;install_url:string;release_url:string;version:string;bundles:string[];requires_key?:boolean}

export function agentInstallCommand(metadata:AgentInstallMetadata,endpoint:string,groupID:string):string {
 const base=endpoint.trim().replace(/\/+$/,''),quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
 if(!base||/[\r\n\0]/.test(base)||/[\r\n\0]/.test(groupID)||!metadata.version)return '';
 // The enrollment token is deliberately read at runtime and never embedded
 // in the generated command, shell history, or copied command text. A
 // temporary curl config keeps it out of curl's argv while downloading the
 // package and installer.
 return `(\n  set -eu\n  umask 077\n  if command -v systemd-ask-password >/dev/null 2>&1; then\n    LIGHTMONI_ENROLLMENT_TOKEN=$(systemd-ask-password 'LightMoni enrollment token')\n  else\n    printf '%s' 'LightMoni enrollment token: ' >&2\n    IFS= read -r LIGHTMONI_ENROLLMENT_TOKEN\n  fi\n  LIGHTMONI_CURL_CONFIG=$(mktemp)\n  trap 'rm -f "$LIGHTMONI_CURL_CONFIG" lightmoni-install.sh; unset LIGHTMONI_ENROLLMENT_TOKEN' EXIT HUP INT TERM\n  printf 'header = "Authorization: Bearer %s"\\n' "$LIGHTMONI_ENROLLMENT_TOKEN" > "$LIGHTMONI_CURL_CONFIG"\n  curl -fSL --config "$LIGHTMONI_CURL_CONFIG" ${quote(base+'/downloads/agent/install.sh')} -o lightmoni-install.sh\n  sudo -v\n  printf '%s\\n' "$LIGHTMONI_ENROLLMENT_TOKEN" | sudo -n sh lightmoni-install.sh --release-url ${quote(base+'/downloads/agent')} --version ${quote(metadata.version)} --endpoint ${quote(base)} --group-id ${quote(groupID)} --enrollment-token-stdin\n)`;
}
