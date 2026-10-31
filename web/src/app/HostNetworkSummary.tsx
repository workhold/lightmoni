import {Collapse,Table,Tag,Tooltip,Typography} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import {classifyNetworkAddresses,interfaceRole,ipAddressCategory,sshAddressCategory} from './host-network-view';
import './connection-credentials.css';

export type HostNetworkAddress={interface:string;address:string;family:'IPv4'|'IPv6';scope:'private'|'public'|'link_local'|'loopback'};
export type HostNetwork={hostname:string;addresses:HostNetworkAddress[];private_ips:string[];public_ips:string[];observed_at:string;observed_via:'ssh'|'agent'|'unavailable';source_ip:string;source_observed_at:string;source_kind:'direct'|'trusted_proxy'|'unavailable'};
export function SSHAddressCategoryTag({address}:{address?:string}){
 const {t}=useI18n(),category=sshAddressCategory(address||'');
 const labels={public:t('公网范围入口','Public-range entry'),private:t('内网入口','Private entry'),shared:t('共享地址入口','Shared-address entry'),hostname:t('域名入口','Hostname entry'),loopback:t('回环入口','Loopback entry'),link_local:t('链路本地入口','Link-local entry'),special:t('特殊范围入口','Special-range entry'),invalid:t('地址待核对','Address needs verification'),unconfigured:t('入口未配置','Entry not configured')};
 return <Tooltip title={t('登记的 SSH 连接目标；类型只按地址格式与范围分类，未验证公网可达性，也不解析域名。','The configured SSH target. The label reflects its format and address range, without testing public reachability or resolving DNS.')}><Tag className="lm-host-entry-category">{labels[category]}</Tag></Tooltip>;
}
export default function HostNetworkSummary({network,details=false,showSource=true}:{network?:HostNetwork;details?:boolean;showSource?:boolean}){
 const {t,language}=useI18n(),time=(value?:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(language):t('待发现','Not discovered');
 const observedVia=network?.observed_via==='ssh'?t('SSH 预检','SSH preflight'):network?.observed_via==='agent'?t('Agent 心跳','Agent heartbeat'):t('未记录','Not recorded');
 const raw=network?.addresses??[],groups=classifyNetworkAddresses(raw),source=network?.source_ip||'',sourceCategory=ipAddressCategory(source),publicSource=showSource&&source&&sourceCategory==='public';
 const sourceLabels={private:t('平台连接来源（内网）','Platform connection source (private)'),shared:t('平台连接来源（共享地址）','Platform connection source (shared address)'),loopback:t('平台连接来源（回环）','Platform connection source (loopback)'),link_local:t('平台连接来源（链路本地）','Platform connection source (link-local)'),special:t('平台连接来源（特殊范围）','Platform connection source (special range)'),invalid:t('平台连接来源（待核对）','Platform connection source (needs verification)'),public:t('到平台的公网来源','Public source to platform')};
 const sourceHint=t('只表示 Agent 到平台这条连接的来源。内网来源可能是反向代理或容器网络；公网来源也不能证明主机公网入口或其他流量的出口。','This is the source of the Agent connection to the platform. Private sources may be a proxy or container network. Public sources do not establish the host’s public entry point or egress for other traffic.');
 const categoryName=(category:ReturnType<typeof ipAddressCategory>)=>({public:t('公网范围','Public range'),private:t('内网','Private'),shared:t('共享地址','Shared address'),loopback:t('回环','Loopback'),link_local:t('链路本地','Link-local'),special:t('特殊范围','Special range'),invalid:t('待核对','Needs verification')}[category]);
 const roleName=(name:string)=>({ordinary:t('普通命名接口','Ordinary interface name'),container:t('容器/虚拟网络','Container/virtual network'),tunnel:t('VPN / 隧道','VPN / tunnel')}[interfaceRole(name)]);
 const addresses=(label:string,entries:HostNetworkAddress[])=>{
  const values=[...new Set(entries.map(value=>value.address))];if(!values.length)return null;
  return <Tooltip title={`${values.join('、')} · ${t('最近发现：','Last discovered: ')}${time(network?.observed_at)}`}><Typography.Text type="secondary">{label}：{values.slice(0,2).join('、')}{values.length>2?` (+${values.length-2})`:''}</Typography.Text></Tooltip>;
 };
 const addressTable=(entries:HostNetworkAddress[])=><Table<HostNetworkAddress> className="lm-host-network-table" size="small" rowKey={(row,index)=>`${row.interface}:${row.address}:${index}`} dataSource={entries} pagination={false} scroll={{x:580}} locale={{emptyText:network?.observed_at?t('本次采集未发现网卡地址','No interface addresses found in this snapshot'):t('尚未发现网卡地址，可执行 SSH 安装检查或等待 Agent 上报','No interface addresses discovered. Run SSH preflight or wait for Agent reporting.')}} columns={[
  {title:t('网卡','Interface'),dataIndex:'interface',render:value=><><Typography.Text>{value||t('未命名接口','Unnamed interface')}</Typography.Text><Typography.Text type="secondary" className="lm-network-interface-role">{roleName(value)}</Typography.Text></>},
  {title:t('IP 地址','IP address'),dataIndex:'address',render:value=><Typography.Text code copyable>{value}</Typography.Text>},
  {title:t('协议','Protocol'),dataIndex:'family'},
  {title:t('范围','Scope'),dataIndex:'address',render:value=><Tooltip title={ipAddressCategory(value)==='public'?t('地址范围不代表公网可达；未做探测。','Address range does not establish public reachability; no probe was performed.'):undefined}><Tag>{categoryName(ipAddressCategory(value))}</Tag></Tooltip>},
 ]}/>;
 const privateAddresses=groups.privateAddresses.filter(entry=>ipAddressCategory(entry.address)==='private'),sharedAddresses=groups.privateAddresses.filter(entry=>ipAddressCategory(entry.address)==='shared');
 const primaryCount=groups.privateAddresses.length+groups.publicAddresses.length+groups.tunnelAddresses.length;
 return <div className="lm-host-addresses">
  {network?.hostname&&<Typography.Text type="secondary">{t('系统主机名','System hostname')}：{network.hostname}</Typography.Text>}
  {addresses(t('内网 IP','Private IP'),privateAddresses)}
  {addresses(t('共享地址 IP','Shared-address IP'),sharedAddresses)}
  {addresses(t('公网范围网卡 IP','Public-range interface IP'),groups.publicAddresses)}
  {addresses(t('VPN / 隧道 IP','VPN / tunnel IP'),groups.tunnelAddresses)}
  {!primaryCount&&<Typography.Text type="secondary">{network?.observed_at?t('本次未发现主机网卡地址','No host interface addresses in this snapshot'):t('尚未发现主机网卡地址','Host interface addresses not discovered')}{groups.otherAddresses.length?t('（其他地址见详情）',' (other addresses in details)'):''}</Typography.Text>}
  {!!network?.observed_at&&<Typography.Text type="secondary">{t('网卡采集','Interface discovery')}：{observedVia} · {time(network.observed_at)}</Typography.Text>}
  {publicSource&&<Tooltip title={sourceHint+` · ${t('最近发现：','Last discovered: ')}${time(network?.source_observed_at)}`}><Typography.Text type="secondary">{t('到平台的公网来源','Public source to platform')}：{source}</Typography.Text></Tooltip>}
  {details&&<>
   {showSource&&source&&!publicSource&&<Tooltip title={sourceHint}><Typography.Text type="secondary">{sourceLabels[sourceCategory]}：{source}</Typography.Text></Tooltip>}
   {showSource&&source&&<Typography.Text type="secondary">{t('平台来源观测时间','Source address observed at')}：{time(network?.source_observed_at)} · {network?.source_kind==='trusted_proxy'?t('可信代理','Trusted proxy'):t('TCP 对端（可能含代理）','TCP peer (may be a proxy)')}</Typography.Text>}
   {showSource&&<Typography.Text type="secondary">{t('公网服务入口（NAT/映射）：待确认；公网/内网出口：待确认','Public service entry (NAT/mapping): unconfirmed; Public/private egress: unconfirmed')}</Typography.Text>}
   <Typography.Text type="secondary">{t('接口类型仅根据名称分类，未探测系统设备类型。','Interface roles are inferred from names; OS device types were not inspected.')}</Typography.Text>
   {!!groups.otherAddresses.length&&<Collapse ghost className="lm-network-collapse" items={[{key:'other',label:t('其他地址（容器、回环及特殊范围）','Other addresses (container, local, and special ranges)')+` · ${groups.otherAddresses.length}`,children:addressTable(groups.otherAddresses)}]}/>}
   <Collapse ghost className="lm-network-collapse" items={[{key:'raw',label:t('全部原始网卡地址','All raw interface addresses')+` · ${raw.length}`,children:<>{!!network?.observed_at&&<Typography.Paragraph type="secondary">{observedVia} · {time(network.observed_at)}</Typography.Paragraph>}{addressTable(raw)}</>}]}/>
  </>}
 </div>;
}
