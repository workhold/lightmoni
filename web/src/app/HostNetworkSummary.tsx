import {Table,Tag,Tooltip,Typography} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import './connection-credentials.css';

export type HostNetworkAddress={interface:string;address:string;family:'IPv4'|'IPv6';scope:'private'|'public'|'link_local'|'loopback'};
export type HostNetwork={hostname:string;addresses:HostNetworkAddress[];private_ips:string[];public_ips:string[];observed_at:string;observed_via:'ssh'|'agent'|'unavailable';source_ip:string;source_observed_at:string;source_kind:'direct'|'trusted_proxy'|'unavailable'};
export default function HostNetworkSummary({network,details=false,showSource=true}:{network?:HostNetwork;details?:boolean;showSource?:boolean}){
 const {t,language}=useI18n(),time=(value?:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(language):t('待发现','Not discovered');
 const observedVia=network?.observed_via==='ssh'?t('SSH 预检','SSH preflight'):network?.observed_via==='agent'?t('Agent 心跳','Agent heartbeat'):t('未记录','Not recorded');
 const addresses=(label:string,values:string[])=>{
  const all=values.join('、');return <Tooltip title={values.length?`${all} · ${t('最近发现：','Last discovered: ')}${time(network?.observed_at)}`:undefined}><Typography.Text type="secondary">{label}：{values.length?<>{values.slice(0,2).join('、')}{values.length>2?` (+${values.length-2})`:''}</>:network?.observed_at?t('未发现','None discovered'):t('待发现','Not discovered')}</Typography.Text></Tooltip>;
 };
 return <div className="lm-host-addresses">
  {network?.hostname&&<Typography.Text type="secondary">{t('系统主机名','System hostname')}：{network.hostname}</Typography.Text>}
  {addresses(t('内网 IP','Private IP'),network?.private_ips??[])}
  {!!network?.public_ips?.length&&addresses(t('其他网卡 IP','Other interface IPs'),network.public_ips)}
  {!!network?.observed_at&&<Typography.Text type="secondary">{t('网卡采集','Interface discovery')}：{observedVia} · {time(network.observed_at)}</Typography.Text>}
  {showSource&&<Tooltip title={t('平台根据 Agent 连接记录的来源地址，仅代表这条连接，不能确定公网入口或其他流量的出口。','The source observed from an Agent connection describes only that connection; it does not establish a public entry point or the egress for other traffic.')+` · ${t('最近发现：','Last discovered: ')}${time(network?.source_observed_at)}`}><Typography.Text type="secondary">{t('平台观测来源 IP','Platform-observed source IP')}：{network?.source_ip||t('待发现','Not discovered')}</Typography.Text></Tooltip>}
  {details&&<>
   {showSource&&<Typography.Text type="secondary">{t('平台来源观测时间','Source address observed at')}：{time(network?.source_observed_at)}{network?.source_ip?` · ${network.source_kind==='trusted_proxy'?t('可信代理','Trusted proxy'):t('直接连接','Direct connection')}`:''}</Typography.Text>}
   <Table className="lm-host-network-table" size="small" rowKey={row=>`${row.interface}:${row.address}`} dataSource={network?.addresses??[]} pagination={false} scroll={{x:500}} locale={{emptyText:network?.observed_at?t('本次采集未发现网卡地址','No interface addresses found in this snapshot'):t('尚未发现网卡地址，可执行 SSH 安装检查或等待 Agent 上报','No interface addresses discovered. Run SSH preflight or wait for Agent reporting.')}} columns={[
    {title:t('网卡','Interface'),dataIndex:'interface'},
    {title:t('IP 地址','IP address'),dataIndex:'address',render:value=><Typography.Text code copyable>{value}</Typography.Text>},
    {title:t('协议','Protocol'),dataIndex:'family'},
    {title:t('范围','Scope'),dataIndex:'scope',render:(value:HostNetworkAddress['scope'])=><Tooltip title={value==='public'?t('网卡地址范围不代表公网可达','Interface address scope does not establish public reachability'):undefined}><Tag>{{private:t('内网','Private'),public:t('公网范围','Public range'),link_local:t('链路本地','Link-local'),loopback:t('回环','Loopback')}[value]}</Tag></Tooltip>},
   ]}/>
  </>}
 </div>;
}
