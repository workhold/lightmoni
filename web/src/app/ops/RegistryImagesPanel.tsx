import ManagedExecutionResult from './ManagedExecutionResult';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {DeleteOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Empty,Modal,Select,Space,Table,Tag,Typography} from '../../shared/ui';
import {api,post} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {errorText,type Run,type Spec} from './model';

type Version={tag:string;digest:string;used_by:{id:string;name:string}[]};
const terminal=new Set(['succeeded','failed','cancelled','expired','unknown']);
export default function RegistryImagesPanel({registry,clusterName,onChange,machineName}:{registry:Spec;clusterName:(id:string)=>string;onChange:()=>void;machineName:(id:string)=>string}) {
  const {t}=useI18n();
  const deployments=registry.deployments??[];
  const [selected,setSelected]=useState<string>(),[repository,setRepository]=useState<string>();
  const cid=selected??deployments[0]?.cluster_id;
  const [repositories,setRepositories]=useState<string[]>([]),[versions,setVersions]=useState<Version[]>([]),[next,setNext]=useState<string|null>(null),[cursors,setCursors]=useState<string[]>([]);
  const [pollRevision,setPollRevision]=useState(0),[executionOpen,setExecutionOpen]=useState(false),[usageComplete,setUsageComplete]=useState(true);
  const [loading,setLoading]=useState(false),[error,setError]=useState(''),[confirm,setConfirm]=useState(false),[cleanup,setCleanup]=useState<Run>(),[submitting,setSubmitting]=useState(false);
  const generation=useRef(0),cleanupGeneration=useRef(0);
  const recovered=registry.cleanup_run as Run|null;
  const blocked=!!recovered || submitting || !!cleanup&&!terminal.has(cleanup.state);
  const explain=useCallback((code:string)=>{
    const copy:Record<string,[string,string]>={
      registry_executor_upgrade_required:['请先升级此机器的受管执行器，再读取仓库。','Upgrade this machine’s managed executor before browsing.'],
      registry_deployment_not_started:['仓库尚未启动，请先完成部署。','Start the registry deployment first.'],
      registry_request_failed:['仓库读取失败，请检查部署状态后重试。','Registry request failed. Check the deployment and retry.'],
      registry_delete_rejected:['仓库拒绝删除部分版本，请检查权限后重试。','The registry rejected some deletions. Check permissions and retry.'],
      registry_reference_not_found:['引用的镜像版本无法读取，已停止清理。请核对应用和仓库版本。','A referenced version could not be read. Verify application and registry versions before cleanup.'],
      registry_delete_disabled:['仓库尚未启用删除，请在部署列表中重新部署后重试。','Deletion is disabled. Redeploy the registry and retry.'],
      registry_usage_unresolved:['无法完整确认应用引用，已停止清理。请检查应用镜像配置与部署记录。','Application references could not be fully verified. Check image settings and deployment records.'],
      registry_cleanup_in_progress:['已有清理任务，请等待完成；结果不确定时需先在执行记录中核查并解决。','A cleanup is pending. Wait for completion, or reconcile an unknown result in execution history.'],
      registry_scan_limit:['仓库超过本次扫描上限，未执行清理。','The registry exceeds the scan limit. No cleanup was performed.'],
      platform_revision_conflict:['仓库配置已变化，请刷新后重试。','Registry configuration changed. Refresh and retry.'],
    };
    return copy[code]?t(...copy[code]):t('仓库操作失败：','Registry operation failed: ')+code;
  },[t]);
  const waitRun=async(run:Run,valid:()=>boolean)=>{
    while(!terminal.has(run.state)){
      await new Promise(resolve=>setTimeout(resolve,750));
      if(!valid())return undefined;
      run=await api<Run>('/ops/runs/'+encodeURIComponent(run.id));
    }
    return valid()?run:undefined;
  };
  const query=useCallback(async(repo?:string,after?:string)=>{
    if(!cid)return;
    const seq=++generation.current;
    setLoading(true);setError('');setVersions([]);setNext(null);
    try{
      const queued=await post<Run>('/ops/private-registry/images/query',{cluster_id:cid,...(repo?{repository:repo,...(after?{after}:{})}:{})});
      const run=await waitRun(queued,()=>seq===generation.current);
      if(!run)return;
      if(run.state!=='succeeded')throw Error(run.result?.code??run.state);
      if(repo){setUsageComplete(run.result.usage_complete!==false);setVersions(run.result.versions??[]);setNext(run.result.next??null);}else setRepositories(run.result.repositories??[]);
    }catch(e){if(seq===generation.current)setError(explain(errorText(e)));}
    finally{if(seq===generation.current)setLoading(false);}
  },[cid,explain]);
  useEffect(()=>{setRepository(undefined);setRepositories([]);setCursors([]);if(!registry.cleanup_run)void query();return()=>{generation.current++;};},[query]);
  useEffect(()=>()=>{cleanupGeneration.current++;},[]);
  useEffect(()=>{if(recovered)setCleanup(recovered);},[recovered?.id,recovered?.state]);
  useEffect(()=>{
    if(!recovered || submitting || terminal.has(recovered.state))return;
    let live=true;
    void waitRun(recovered,()=>live).then(run=>{
      if(!run)return;
      setCleanup(run);onChange();
      if(run.state!=="unknown"){setCursors([]);void query(repository);}
    }).catch(e=>{if(live)setError(explain(errorText(e)));});
    return()=>{live=false;};
  },[recovered?.id,submitting,query,pollRevision]);
  const clean=async()=>{
    if(submitting||blocked)return;
    const seq=++cleanupGeneration.current;setSubmitting(true);setError('');
    try{
      const queued=await post<Run>('/ops/private-registry/images/cleanup',{cluster_id:cid,revision:registry.revision,confirmed:true});
      setCleanup(queued);setConfirm(false);onChange();
      const run=await waitRun(queued,()=>seq===cleanupGeneration.current);
      if(!run)return;
      setCleanup(run);onChange();
      if(run.state!=='unknown'){setCursors([]);void query(repository);}
    }catch(e){if(seq===cleanupGeneration.current)setError(explain(errorText(e)));}
    finally{if(seq===cleanupGeneration.current)setSubmitting(false);}
  };
  const result=cleanup?.result,unknown=recovered?.state==='unknown';
  const cleanupDetail=[...new Set<string>((result?.failures??[]).map((f:Spec)=>explain(f.code))),...(result?.skipped?[t(`另有 ${result.skipped} 个摘要未处理。`,`Another ${result.skipped} digests were not processed.`)]:[])].join(' ');
  return <div className="lm-ops-panel lm-registry-images">
    <div className="lm-ops-subheading">
      <h3>{t('镜像与版本','Images and versions')}</h3>
      <Space wrap>
        <Button aria-label={t("刷新镜像","Refresh images")} icon={<ReloadOutlined aria-hidden/>} loading={loading} disabled={blocked||!cid} onClick={()=>void query(repository,cursors.at(-1))}>{t('刷新镜像','Refresh images')}</Button>
        <Button aria-label={t("清理未使用版本","Clean up unused versions")} danger icon={<DeleteOutlined aria-hidden/>} disabled={blocked||!cid} loading={submitting||!!recovered&&recovered.state!=='unknown'} onClick={()=>setConfirm(true)}>{t('清理未使用版本','Clean up unused versions')}</Button>
      </Space>
    </div>
    <div className="lm-registry-filters">
      <label>{t('仓库部署','Registry deployment')}<Select aria-label={t('仓库部署','Registry deployment')} value={cid} disabled={blocked} onChange={value=>setSelected(value)} options={deployments.map((d:Spec)=>({value:d.cluster_id,label:clusterName(d.cluster_id)+' · '+d.address}))}/></label>
      <label>{t('镜像','Image')}<Select aria-label={t('镜像','Image')} showSearch allowClear optionFilterProp="label" value={repository} disabled={loading||blocked} placeholder={t('选择镜像查看版本','Select an image to view versions')} options={repositories.map(value=>({value,label:value}))} onChange={value=>{setRepository(value);setCursors([]);void query(value);}}/></label>
    </div>
    {error&&<Alert type="error" showIcon title={error} action={<Button size="small" onClick={()=>{if(blocked){setPollRevision(v=>v+1);onChange();}else void query(repository,cursors.at(-1));}}>{t('重试','Retry')}</Button>}/>}
    {blocked&&<Alert type={unknown?'warning':'info'} showIcon title={unknown?t('清理结果不确定，应用配置与发布保护仍在生效。','Cleanup outcome is unknown. Application changes and deployments remain locked.'):t('正在清理仓库，暂时暂停应用配置与发布。','Cleaning the registry. Application changes and deployments are temporarily paused.')} description={<Button type="link" onClick={()=>setExecutionOpen(true)}>{t('查看和核查执行记录','View and reconcile execution history')}</Button>}/>}
    {cleanup&&terminal.has(cleanup.state)&&cleanup.state!=='unknown'&&<Alert showIcon type={cleanup.state==='succeeded'?'success':'warning'} title={result?.scanned!==undefined?t(`已删除 ${result.deleted} 个摘要（${result.deleted_tags} 个标签），保留 ${result.retained} 个使用中摘要，失败 ${result.failed} 项。`,`Deleted ${result.deleted} digests (${result.deleted_tags} tags), retained ${result.retained} used digests, ${result.failed} failures.`):explain(result?.code??cleanup.state)} description={cleanupDetail||undefined}/>}
    {!usageComplete&&<Alert type="warning" showIcon title={t('部分应用引用无法解析；未匹配版本标记为待核查，清理前必须完成引用核验。','Some application references could not be resolved. Unmatched versions are unverified; cleanup requires complete reference verification.')}/>}
    <p className="lm-ops-note lm-registry-table-hint">{t('横向滚动查看摘要、使用状态和引用应用。','Scroll horizontally to view digests, usage and applications.')}</p>
    <Table<Version> rowKey="tag" size="small" loading={loading} dataSource={versions} pagination={false} scroll={{x:680}} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={repository?t('此镜像暂无版本','This image has no versions'):repositories.length?t('选择镜像查看全部版本','Select an image to view all versions'):t('仓库中暂无镜像','No images in this registry')}/>}} columns={[
      {title:t('版本标签','Version tag'),dataIndex:'tag',width:180,render:(tag:string)=><Typography.Text copyable>{tag}</Typography.Text>},
      {title:t('摘要','Digest'),dataIndex:'digest',width:230,render:(digest:string)=><Typography.Text className="lm-registry-digest" copyable={{text:digest}} title={digest}>{digest.slice(0,19)}…</Typography.Text>},
      {title:t('使用状态','Usage'),key:'usage',width:140,render:(_,v)=><Tag color={v.used_by.length?'green':'default'}>{v.used_by.length?t('使用中','In use'):usageComplete?t('未使用','Unused'):t('待核查','Unverified')}</Tag>},
      {title:t('引用应用','Applications'),key:'apps',render:(_,v)=>v.used_by.length?<Space wrap>{v.used_by.map(a=><Link key={a.id} to={'/applications?resource='+encodeURIComponent(a.id)}>{a.name}</Link>)}</Space>:<Typography.Text type="secondary">—</Typography.Text>},
    ]}/>
    {repository&&(cursors.length>0||next)&&<Space className="lm-registry-pagination"><Button disabled={!cursors.length||loading||blocked} onClick={()=>{const previous=cursors.slice(0,-1);setCursors(previous);void query(repository,previous.at(-1));}}>{t('上一页','Previous')}</Button><Typography.Text>{t(`第 ${cursors.length+1} 页`,`Page ${cursors.length+1}`)}</Typography.Text><Button disabled={!next||loading||blocked} onClick={()=>{if(next){setCursors([...cursors,next]);void query(repository,next);}}}>{t('下一页','Next')}</Button></Space>}
    <Modal title={t('清理执行记录','Cleanup execution history')} open={executionOpen} onCancel={()=>{setExecutionOpen(false);onChange();}} footer={null} width={760} destroyOnHidden>
      {cleanup?.job_id&&<ManagedExecutionResult jobID={cleanup.job_id} hostID={deployments.find((d:Spec)=>d.cluster_id===cid)?.machine_id??''} hostName={machineName(deployments.find((d:Spec)=>d.cluster_id===cid)?.machine_id??'')}/>}
    </Modal>
    <Modal title={t('清理所有未使用的历史版本','Clean up all unused historical versions')} open={confirm} onCancel={()=>{if(!submitting)setConfirm(false);}} onOk={()=>void clean()} confirmLoading={submitting} okButtonProps={{danger:true}} okText={t('确认清理','Confirm cleanup')} cancelText={t('取消','Cancel')}>
      <p>{t('将检查所选部署的全部镜像，删除没有任何 LightMoni 应用引用的版本。当前镜像筛选不会限制清理范围。','Checks every image in the selected deployment and deletes versions that no LightMoni application references. The image filter does not limit cleanup.')}</p>
      <p>{t('停止的应用、部署中的旧版本、相同摘要标签及多架构依赖会被保留。执行期间暂时暂停应用和网站配置及发布。','Stopped applications, previous deployed versions, digest aliases and multi-platform dependencies are retained. Application and website changes and deployments pause during cleanup.')}</p>
      <p>{t('平台无法识别未登记的外部应用引用。删除不可撤销，且不会立即回收镜像层占用的磁盘空间。','References from external applications are not tracked. Deletion cannot be undone and does not immediately reclaim layer storage.')}</p>
      {error&&<Alert type="error" showIcon title={error}/>}
    </Modal>
  </div>;
}
