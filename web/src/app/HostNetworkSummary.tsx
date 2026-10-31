import {Table,Tag,Tooltip,Typography} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import './connection-credentials.css';

export type HostNetwork={addresses:{interface:string;address:string;family:'IPv4'|'IPv6';scope:'private'|'public'|'link_local'|'loopback'}[];private_ips:string[];public_ips:string[];observed_at:string;source_ip:string;source_observed_at:string;source_kind:'direct'|'trusted_proxy'|'unavailable'};
export default function HostNetworkSummary({network,details=false}:{network?:HostNetwork;details?:boolean}){
 const {t,language}=useI18n(),time=(value?:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(language):t('待发现','Not discovered');
 const addresses=(label:string,values:string[])=>{
  const all=values.join('、');return <Tooltip title={values.length?`${all} · ${t('最近发现：','Last discovered: ')}${time(network?.observed_at)}`:undefined}><Typography.Text type="secondary">{label}：{values.length?<>{values.slice(0,2).join('、')}{values.length>2?` (+${values.length-2})`:''}</>:network?.observed_at?t('未发现','None discovered'):t('待发现','Not discovered')}</Typography.Text></Tooltip>;
 };
 return <div className="lm-host-addresses">
  {addresses(t('内网 IP','Private IP'),network?.private_ips??[])}
  {!!network?.public_ips?.length&&addresses(t('其他网卡 IP','Other interface IPs'),network.public_ips)}
  <Tooltip title={t('平台根据 Agent 连接记录的来源地址，可能是内网、NAT 或代理出口。','The source address observed from Agent connections. It may belong to a private network, NAT, or proxy.')+` · ${t('最近发现：','Last discovered: ')}${time(network?.source_observed_at)}`}><Typography.Text type="secondary">{t('出口 / 来源 IP','Egress / source IP')}：{network?.source_ip||t('待发现','Not discovered')}</Typography.Text></Tooltip>
  {details&&<>
   <Typography.Text type="secondary">{t('主机地址发现时间','Host addresses observed at')}：{time(network?.observed_at)}</Typography.Text>
   <Typography.Text type="secondary">{t('平台来源观测时间','Source address observed at')}：{time(network?.source_observed_at)}{network?.source_ip?` · ${network.source_kind==='trusted_proxy'?t('可信代理','Trusted proxy'):t('直接连接','Direct connection')}`:''}</Typography.Text>
   <Table className="lm-host-network-table" size="small" rowKey={row=>`${row.interface}:${row.address}`} dataSource={network?.addresses??[]} pagination={false} scroll={{x:500}} locale={{emptyText:t('等待 Agent 发现网卡地址','Waiting for Agent to discover network addresses')}} columns={[
    {title:t('网卡','Interface'),dataIndex:'interface'},
    {title:t('IP 地址','IP address'),dataIndex:'address',render:value=><Typography.Text code copyable>{value}</Typography.Text>},
    {title:t('协议','Protocol'),dataIndex:'family'},
    {title:t('范围','Scope'),dataIndex:'scope',render:(value:HostNetwork['addresses'][number]['scope'])=><Tag>{{private:t('内网','Private'),public:t('公网','Public'),link_local:t('链路本地','Link-local'),loopback:t('回环','Loopback')}[value]}</Tag>},
   ]}/>
  </>}
 </div>;
}
