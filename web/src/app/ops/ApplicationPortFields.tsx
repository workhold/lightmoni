import { Form, InputNumber, Typography } from '../../shared/ui';
import { useI18n } from '../../shared/i18n';
import type { Spec } from './model';

export default function ApplicationPortFields({ports, prefix=['host_ports'], onChange}:{ports:Spec[];prefix?:(string|number)[];onChange?:(name:string)=>void}){
 const {t}=useI18n();
 const labels:Record<string,string>={registry:t('私有仓库','Private registry'),'hub-cache':t('Docker Hub 缓存','Docker Hub cache'),'origin-cache':t('发布源缓存','Publishing source cache')};
 return <section className="lm-application-ports" aria-label={t('端口映射','Port mappings')}>
  <h3>{t('端口映射','Port mappings')}</h3>
  <p className="lm-ops-note">{t('填写宿主端口；0 表示由平台分配可用端口。','Enter a host port; 0 lets the platform allocate an available port.')}</p>
  {ports.map(p=><div className="lm-application-port" key={p.name}>
   <Form.Item name={[...prefix,p.name]} label={t('宿主端口','Host port')+' · '+(labels[p.name]??p.name)} rules={[{required:true,message:t('填写端口，或填 0 自动分配','Enter a port, or 0 for automatic allocation')},{type:'integer',min:0,max:65535}]}><InputNumber min={0} max={65535} precision={0} onChange={()=>onChange?.(p.name)}/></Form.Item>
   <span className="lm-port-arrow" aria-hidden>→</span><div className="lm-container-port"><Typography.Text type="secondary">{t('容器端口','Container port')}</Typography.Text><strong>{p.container_port} <small>{String(p.protocol??'tcp').toUpperCase()}</small></strong></div>
  </div>)}
 </section>;
}
