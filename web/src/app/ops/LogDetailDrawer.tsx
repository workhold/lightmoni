import type {ComponentProps} from 'react';
import {Descriptions,Drawer,Typography} from '../../shared/ui';
import {useI18n} from '../../shared/i18n';

export default function LogDetailDrawer({open,onClose,fields,body,title}:{open:boolean;onClose:()=>void;fields:ComponentProps<typeof Descriptions>['items'];body?:string;title?:string}){
 const {t}=useI18n();
 return <Drawer open={open} onClose={onClose} title={title??t('日志详情','Log details')} size="min(760px, 100vw)" className="lm-log-detail" destroyOnHidden>
  <Descriptions size="small" column={{xs:1,sm:2}} items={fields}/>
  <div className="lm-log-raw-heading"><h3>{t('原始日志','Raw log')}</h3><Typography.Text copyable={{text:body??''}}>{t('复制','Copy')}</Typography.Text></div>
  <pre className="lm-ops-result">{body||t('无原始日志','No raw log')}</pre>
 </Drawer>;
}
