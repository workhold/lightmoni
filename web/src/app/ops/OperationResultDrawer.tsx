import type {ReactNode} from 'react';
import {ReloadOutlined} from '@ant-design/icons';
import {Alert,Descriptions,Drawer,Typography} from '../../shared/ui';
import {useI18n} from '../../shared/i18n';
import IconAction from './IconAction';
import OperationStatus from './OperationStatus';
import {time,type Run} from './model';

export default function OperationResultDrawer({run,resourceName,actionName,targetName,onClose,onRefresh,children}:{run?:Run;resourceName:string;actionName:string;targetName:string;onClose:()=>void;onRefresh:()=>Promise<void>;children?:ReactNode}){
 const {t}=useI18n();
 const result=run?.result??{},state=run?.state??'',active=['queued','leased','pending','accepted','running','verifying'].includes(state);
 return <Drawer open={!!run} onClose={onClose} title={t('执行结果','Execution result')} size="min(820px, 100vw)" className="lm-operation-result" destroyOnHidden extra={<IconAction label={t('刷新结果','Refresh result')} icon={<ReloadOutlined aria-hidden/>} onClick={()=>void onRefresh()}/>}>
  {run&&<><div className="lm-result-summary"><OperationStatus state={state}/><h2>{resourceName}</h2><span>{actionName}</span></div>
   {state==='unknown'&&<Alert showIcon type="warning" title={t('执行结果未知','Execution outcome unknown')} description={t('先核对目标实际状态，再决定后续操作。原执行记录已保留。','Inspect the actual target state before taking further action. The original execution is retained.')}/>}
   {active&&<Alert showIcon type="info" title={['queued','leased','pending','accepted'].includes(state)?t('请求已提交，等待执行','Request submitted; awaiting execution'):t('请求已提交，正在执行','Request submitted; execution in progress')} description={t('可关闭此窗口，稍后从操作日志查看结果。','You can close this drawer and reopen the result from operation logs.')}/>}
   {result.message&&<Alert showIcon type={['failed','error'].includes(state)?'error':state==='unknown'?'warning':'info'} title={String(result.message)}/>}
   {['failed','error'].includes(state)&&!result.message&&<Alert showIcon type="error" title={t('执行失败','Execution failed')} description={t('请根据结果码核对配置与目标状态，详细信息见原始回执。','Review the result code, configuration and target state. Details are available in the raw receipt.')}/>}
   <Descriptions size="small" column={{xs:1,sm:2}} items={[{key:'target',label:t('目标机器','Target machine'),children:targetName},{key:'revision',label:t('配置版本','Revision'),children:'v'+run.resource_revision},{key:'created',label:t('创建时间','Created'),children:time(run.created_at)},{key:'updated',label:t('更新时间','Updated'),children:time(run.updated_at)},...(result.code?[{key:'code',label:t('结果码','Result code'),children:<Typography.Text code>{String(result.code)}</Typography.Text>}]:[]),{key:'id',label:t('执行 ID','Run ID'),span:'filled' as const,children:<Typography.Text copyable className="lm-result-id">{run.id}</Typography.Text>}]}/>
   {children}
   <details className="lm-ops-details"><summary>{t('原始执行回执','Raw execution receipt')}</summary><pre className="lm-ops-result">{JSON.stringify(result,null,2)}</pre></details>
  </>}
 </Drawer>;
}
