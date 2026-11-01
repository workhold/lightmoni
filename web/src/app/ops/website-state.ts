import type {Resource, Spec} from './model';

type Copy = [string, string];
export type WebsiteState = {key:string; label:Copy; hint:Copy; color?:'success'|'processing'|'warning'|'error'};
const state = (key:string,label:Copy,hint:Copy,color?:WebsiteState['color']):WebsiteState => ({key,label,hint,color});

export function websitePublication(site:Resource,clusterId?:string):WebsiteState {
  const configured:string[]|undefined=site.spec.routing_mode==='managed'?site.status.actual_cluster_ids:site.spec.cluster_ids;
  const ids:string[]=configured?.length?configured:Object.keys(site.status.deployments??{});
  const deployments = (clusterId ? [site.status.deployments?.[clusterId]??{}] : ids.map(id=>site.status.deployments?.[id]??{})) as Spec[];
  const published = deployments.filter(d=>Number(d.desired_revision)>0);
  if (!published.length) return state('unpublished',['未发布','Not published'],['配置已保存，发布后才会同步网站解析。','Configuration is saved. Publish to start website DNS synchronization.']);
  if (published.some(d=>d.phase==='unknown'||Object.values(d.instances??{}).some((i:any)=>i.state==='unknown')))
    return state('unknown',['结果待核对','Needs inspection'],['先检查入口实际状态，再决定是否重新发布。','Inspect the entry state before publishing again.'],'warning');
  const enabled = published.filter(d=>d.enabled);
  if (!enabled.length) return state('disabled',['已停用','Disabled'],['此网站已停止参与入口发布。','This website is disabled at its entries.']);
  const ready = enabled.filter(d=>d.active&&d.synchronized&&(!d.phase||d.phase==='active'));
  if (ready.length===deployments.length)
    return state('published',['已发布','Published'],['各集群入口已确认发布；网站解析单独回读。','All cluster entries confirmed publication. DNS is verified separately.'],'success');
  const failed = enabled.some(d=>d.last_error||d.phase==='failed'||Object.values(d.instances??{}).some((i:any)=>i.state==='failed'));
  if (ready.length) return state('partial',['部分集群已发布','Partially published'],[failed?'部分集群发布失败，请查看逐入口结果。':'部分集群尚未完成发布。',failed?'Publication failed in some clusters. Inspect the entry results.':'Some clusters have not finished publishing.'],'warning');
  if (failed) return state('failed',['发布失败','Publication failed'],['查看逐入口结果，处理后重新发布。','Inspect the entry results, resolve the error and publish again.'],'error');
  return state('publishing',['发布中','Publishing'],['等待入口配置验证和发布回执。','Waiting for entry validation and publication receipts.'],'processing');
}

export function publishedRevisions(site:Resource):number[] {
  return [...new Set<number>(Object.values(site.status.deployments??{}).map((d:any)=>Number(d.desired_revision)).filter(n=>n>0))].sort((a,b)=>b-a);
}

export function dnsErrorCopy(code:unknown):Copy {
  const key = String(code??'');
  const known:Record<string,Copy> = {
    service_backend_not_ready:['托管服务尚无健康后端。','The managed service has no healthy backend.'],
    openresty_cluster_domain_required:['尚未设置集群入口域名。','The cluster entry domain is missing.'],
    openresty_public_ip_required_for_dns:['入口机器缺少可用于解析的公网 IP。','The entry machine needs a public IP for DNS.'],
    machine_public_service_address_required:['主机尚未配置公网服务地址，请到主机管理选择或修正。','The host needs a public service address. Select or correct it in Machines.'],
    dns_verification_pending:['DNS 厂商尚未回读确认。','Waiting for DNS provider verification.'],
    dns_line_not_supported:['DNS 账号或套餐不支持所选线路。','The DNS account or plan does not support the selected line.'],
    dns_owned_record_modified_externally:['自动管理的记录已被外部修改，请核对后处理。','A managed record was changed externally. Inspect it before continuing.'],
  };
  return known[key]??['DNS 同步失败，请查看错误详情。','DNS synchronization failed. Inspect the error details.'];
}

export function websiteDNS(site:Resource,clusterId?:string,domain?:string):WebsiteState {
  const bindings = (site.spec.bindings??[]).filter((b:Spec)=>!domain||b.domains?.includes(domain));
  if (!bindings.some((b:Spec)=>b.dns_enabled)) return state('external',['自行维护','Managed externally'],['网站解析由你维护，系统不会创建 CNAME 或地址记录。','You maintain website DNS. The system will not create CNAME or address records.']);
  const publication = websitePublication(site,clusterId);
  if (publication.key==='unpublished') return state('not_published',['发布后同步','Sync after publication'],['尚未发布，不会生成网站解析。','Not published. Website DNS records are not generated yet.']);
  if (site.status.dns_error) return state('error',['解析同步失败','DNS synchronization failed'],dnsErrorCopy(site.status.dns_error),'error');
  if (publication.key==='disabled') return state('disabled',['停用撤流量','Traffic withdrawal'],['网站已停用，解析撤下结果以厂商回读为准。','The website is disabled. Provider readback confirms DNS withdrawal.']);
  if (publication.key==='unknown') return state('unknown',['先核对发布结果','Inspect publication first'],publication.hint,'warning');
  const route = site.spec.domain_routes?.find((r:Spec)=>r.domain===domain);
  const policy = clusterId ? {...site.spec.cluster_policies?.find((p:Spec)=>p.cluster_id===clusterId),...route?.cluster_policies?.find((p:Spec)=>p.cluster_id===clusterId)} : undefined;
  if (policy?.enabled===false) return state('traffic_off',['流量已关闭','Traffic disabled'],['此域名在该集群不参与解析。','This domain does not route DNS traffic to this cluster.']);
  const traffic = clusterId ? [site.status.cluster_traffic?.[clusterId]??{}] : Object.values(site.status.cluster_traffic??{}) as Spec[];
  const blocker = traffic.find((v:Spec)=>v.error)?.error;
  if (blocker) return state('blocked',['等待配置就绪','Configuration not ready'],dnsErrorCopy(blocker),'warning');
  const membership = domain ? site.status.domain_traffic?.[domain] : undefined;
  const eligible = domain && membership ? (clusterId?membership.eligible_cluster_ids?.includes(clusterId):membership.eligible_cluster_ids?.length>0) : traffic.some((v:Spec)=>v.eligible);
  if (!eligible && publication.key!=='published') return state('waiting_publication',['等待发布完成','Awaiting publication'],['先完成入口发布，再核对网站解析。','Finish publishing to the entries before checking website DNS.'],'processing');
  if (!eligible) return state('waiting_entry',['等待健康入口','Awaiting healthy entry'],['当前没有满足流量条件的健康入口。','No healthy entry currently meets the traffic requirements.'],'processing');
  const results = site.status.dns;
  if (site.status.dns_signature&&site.status.dns_updated_at&&Array.isArray(results)&&results.length&&results.every((r:Spec)=>r.verified===true))
    return state('verified',['最近回读成功','Last readback succeeded'],['已由 DNS 厂商回读；公网缓存传播未检查。','Verified with the DNS provider. Public cache propagation has not been checked.'],'success');
  return state('pending',['等待 DNS 回读','Awaiting DNS readback'],['已有可用入口，等待 DNS 厂商确认解析记录。','An entry is eligible. Waiting for the DNS provider to confirm the records.'],'processing');
}

export function entryDNS(app:Resource,deployment:Spec):WebsiteState {
  if (!deployment.gateway_domain) return state('missing',['未设置入口域名','Entry domain missing'],['先设置供网站 CNAME 指向的稳定域名。','Set a stable domain for website CNAME records.'],'warning');
  if (!deployment.gateway_dns_zone_id) return state('external',['自行维护 A / AAAA','Maintain A / AAAA externally'],['填写入口域名不会创建解析；请自行维护，或改用自动托管。','Entering a domain does not create DNS records. Maintain them yourself or enable managed DNS.']);
  if (['public_ip_required','partial_public_ip_required'].includes(app.status.gateway_dns?.[deployment.cluster_id]?.state)) return state('public_ip_required',['缺少公网服务地址','Public service address missing'],dnsErrorCopy('machine_public_service_address_required'),'warning');
  if (app.status.dns_error) return state('error',['入口解析需核对','Inspect entry DNS'],dnsErrorCopy(app.status.dns_error),'error');
  if (!app.status.deployments?.[deployment.cluster_id]?.enabled) return state('not_deployed',['部署入口后同步','Sync after entry deployment'],['此集群尚未启用入口部署。','The entry deployment is not enabled in this cluster.']);
  const verified = (app.status.dns??[]).some((r:Spec)=>r.verified&&(r.records??[]).some((record:Spec)=>record.name===deployment.gateway_domain&&['A','AAAA'].includes(record.type)&&record.managed_by?.includes(app.id)));
  if (verified&&app.status.dns_updated_at) return state('verified',['最近回读成功','Last readback succeeded'],['最近已确认入口地址记录；公网缓存传播未检查。','The entry address records were verified. Public cache propagation has not been checked.'],'success');
  return state('pending',['等待入口解析回读','Awaiting entry DNS readback'],['系统按健康入口的公网 IP 维护 A / AAAA。','The system maintains A / AAAA records from healthy entries’ public IPs.'],'processing');
}
