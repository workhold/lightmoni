import {DownOutlined} from '@ant-design/icons';
import {App,Button,Dropdown,Empty,Tag} from '../../shared/ui';
import {useI18n} from '../../shared/i18n';
import {publishedRevisions,websiteDNS,websitePublication,type WebsiteState} from './website-state';
import {time,type Resource} from './model';

export function WebsiteStateTag({value}:{value:WebsiteState}) {
  const {t}=useI18n();
  return <Tag color={value.color} className={'lm-ops-state'+(value.color?' lm-ops-state-'+value.color:'')}>{t(...value.label)}</Tag>;
}
function RevisionSummary({resource}:{resource:Resource}) {
  const {t}=useI18n(),versions=publishedRevisions(resource);
  return <span className="lm-website-versions">{t('配置','Config')} v{resource.revision} · {t('发布','Published')} {versions.length?versions.map(v=>'v'+v).join(' / '):'—'}</span>;
}

type Props={websites:Resource[];resources:Resource[];busy:boolean;onEdit:(r:Resource)=>void;onAction:(r:Resource,action:string)=>void;onDetails:(r:Resource)=>void;onTraffic:(r:Resource)=>void;onEntry:()=>void;onRemove:(r:Resource)=>Promise<void>};
export default function WebsiteOverview({websites,resources,busy,onEdit,onAction,onDetails,onTraffic,onEntry,onRemove}:Props) {
  const {t}=useI18n(),{modal}=App.useApp();
  if(!websites.length)return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('还没有网站，先新建配置，再发布到集群入口。','No websites yet. Create a configuration, then publish it to cluster entries.')}/>;
  const entry=resources.find(r=>r.kind==='application'&&r.spec.role==='openresty');
  return <div className="lm-website-list">{websites.map(site=>{
    const publication=websitePublication(site),dns=websiteDNS(site),versions=publishedRevisions(site);
    const ids: string[]=site.spec.routing_mode==='managed'?(site.status.actual_cluster_ids?.length?site.status.actual_cluster_ids:resources.find(r=>r.id===site.spec.service_application_id)?.spec.deployments?.map((d:any)=>d.cluster_id)??[]):site.spec.cluster_ids??[];
    const externalEntry=entry?.spec.deployments?.some((d:any)=>ids.includes(d.cluster_id)&&!d.gateway_dns_zone_id);
    return <article className="lm-website-item" key={site.id} aria-label={site.name}>
      <div className="lm-website-identity"><Button type="link" className="lm-ops-resource-name" onClick={()=>onDetails(site)}>{site.name}</Button>
        <div className="lm-website-domains">{(site.spec.bindings??[]).flatMap((b:any)=>b.domains??[]).map((domain:string)=><span key={domain}>{domain}</span>)}</div>
        <span className="lm-website-clusters">{ids.map(id=>resources.find(r=>r.id===id)?.name??id).join(' · ')}</span>
      </div>
      <dl className="lm-website-statuses">
        <div><dt>{t('配置与发布','Configuration & publication')}</dt><dd><WebsiteStateTag value={publication}/><RevisionSummary resource={site}/></dd>
          {publication.key!=='published'&&<dd className="lm-website-hint">{t(...publication.hint)}</dd>}</div>
        <div><dt>{site.spec.dns_record_mode==='cname'?t('网站 CNAME','Website CNAME'):t('网站地址解析','Website address DNS')}</dt><dd><WebsiteStateTag value={dns}/>{dns.key==='verified'&&<span className="lm-website-versions">{time(site.status.dns_updated_at)}</span>}</dd>
          <dd className="lm-website-hint">{t(...dns.hint)}</dd>
          {externalEntry&&<dd><Button type="link" size="small" onClick={onEntry}>{t('集群入口解析为自行维护 · 查看','Entry DNS is maintained externally · View')}</Button></dd>}</div>
      </dl>
      <div className="lm-website-actions"><Button type="primary" disabled={busy} onClick={()=>onAction(site,publication.key==='unknown'?'inspect':'deploy')}>
        {publication.key==='unknown'?t('检查发布状态','Inspect publication'):versions.length?t('发布当前配置','Publish current config'):t('发布网站','Publish website')}</Button>
        <Button disabled={busy} onClick={()=>onEdit(site)}>{t('编辑配置','Edit configuration')}</Button>
        <Dropdown menu={{items:[
          {key:'details',label:t('发布与解析详情','Publication & DNS details')},
          {key:'traffic',label:t('流量设置','Traffic settings')},
          {key:'inspect',label:t('检查发布状态','Inspect publication')},
          {key:'disable',label:t('停用网站','Disable website'),disabled:!versions.length||publication.key==='disabled'},
          {type:'divider'}, {key:'delete',label:t('删除登记','Delete registration'),danger:true},
        ],onClick:({key})=>{
          if(key==='details')onDetails(site);else if(key==='traffic')onTraffic(site);else if(key==='delete')modal.confirm({title:t('删除此网站登记？','Delete this website registration?'),content:t('已发布的网站需要先停用并清理解析；后端会核对依赖。','Published websites must be disabled and DNS cleaned up first. The server checks dependencies.'),okText:t('删除登记','Delete registration'),cancelText:t('取消','Cancel'),okButtonProps:{danger:true},onOk:()=>onRemove(site)});else onAction(site,key);
        }}}><Button disabled={busy}>{t('更多','More')}<DownOutlined aria-hidden/></Button></Dropdown>
      </div>
    </article>;
  })}</div>;
}

export function WebsiteLifecycle({resource,busy,onEdit,onAction,onEntry}:{resource:Resource;busy:boolean;onEdit:()=>void;onAction:(action:string)=>void;onEntry:()=>void}) {
  const {t}=useI18n(),publication=websitePublication(resource),dns=websiteDNS(resource);
  return <section className="lm-website-lifecycle" aria-label={t('配置、发布与解析','Configuration, publication and DNS')}>
    <div><h3>{t('配置','Configuration')}</h3><strong>v{resource.revision} {t('已保存','saved')}</strong><p>{t('保存只更新配置，发布后才应用到入口。','Saving updates the configuration. Publication applies it to entries.')}</p><Button size="small" onClick={onEdit}>{t('编辑配置','Edit configuration')}</Button></div>
    <div><h3>{t('发布到集群','Publish to clusters')}</h3><WebsiteStateTag value={publication}/><p>{t(...publication.hint)}</p><Button type="primary" size="small" disabled={busy} onClick={()=>onAction(publication.key==='unknown'?'inspect':'deploy')}>{publication.key==='unknown'?t('检查发布状态','Inspect publication'):t('发布当前配置','Publish current config')}</Button></div>
    <div><h3>{resource.spec.dns_record_mode==='cname'?t('网站 CNAME','Website CNAME'):t('网站地址解析','Website address DNS')}</h3><WebsiteStateTag value={dns}/><p>{t(...dns.hint)}</p><Button size="small" onClick={onEntry}>{t('查看集群入口解析','View cluster entry DNS')}</Button></div>
  </section>;
}
