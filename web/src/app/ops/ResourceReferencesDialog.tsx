import {Alert,Button,Modal,Space,Tag,Typography} from '../../shared/ui';
import {useI18n} from '../../shared/i18n';
import {KIND_NAMES,type ResourceKind} from './model';

export type ResourceReference={id:string;kind:ResourceKind;name:string;domains:string[];sources:{type:'saved'|'published';revision:number}[]};
export default function ResourceReferencesDialog({target,references,onClose,onView}:{target:string;references:ResourceReference[];onClose:()=>void;onView:(reference:ResourceReference)=>void}){
 const {t}=useI18n();
 return <Modal open title={t('无法删除「','Cannot delete “')+target+t('」','”')} onCancel={onClose} footer={<Button onClick={onClose}>{t('关闭','Close')}</Button>}>
  <Alert type="warning" showIcon title={t('以下资源仍在引用，请先解除引用。','The following resources still reference it. Remove these references first.')}/>
  <ul aria-label={t('引用资源','Referencing resources')} style={{listStyle:'none',padding:0,margin:'16px 0 0',maxHeight:'55vh',overflowY:'auto',overflowWrap:'anywhere'}}>
   {references.map(r=><li key={r.id} style={{padding:'12px 0',borderBottom:'1px solid var(--lm-border, #e5e7eb)'}}>
    <Space wrap><Tag>{t(...KIND_NAMES[r.kind])}</Tag><Typography.Text strong>{r.name}</Typography.Text></Space>
    {r.domains.length>0&&<div style={{marginTop:6}}>{r.domains.join('、')}</div>}
    <div style={{marginTop:6,color:'var(--lm-muted)'}}>{r.sources.map(s=>(s.type==='saved'?t('已保存配置','Saved configuration'):t('已发布版本','Published revision'))+' v'+s.revision).join(' · ')}</div>
    <Button type="link" style={{paddingInline:0}} onClick={()=>onView(r)}>{t('查看资源','View resource')}</Button>
   </li>)}
  </ul>
 </Modal>;
}
