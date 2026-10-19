import {useMonitoringI18n} from '../monitoring-i18n';
import {useState} from 'react';
import {PlusOutlined} from '@ant-design/icons';
import {Button,Modal} from '../../shared/ui';
import VisualizationPicker from './VisualizationPicker';
import {adaptPanelType,newPanel,type Panel} from './model';

export default function AddVisualization({index,onSelect,onClose}:{index:number;onSelect:(panel:Panel)=>void;onClose:()=>void}){
 const {l,language}=useMonitoringI18n();

 const [type,setType]=useState('line');
 function create(){onSelect(adaptPanelType(newPanel(undefined,index,language),type,[]));}
 return <Modal open title={l("添加可视化")} onCancel={onClose} width={740} footer={<><Button onClick={onClose}>{l("取消")}</Button><Button type="primary" icon={<PlusOutlined aria-hidden/>} onClick={create}>{l("创建图表")}</Button></>} rootClassName="lm-add-visualization" styles={{body:{maxHeight:'60vh',overflowY:'auto'}}} destroyOnHidden>
  <h3>{l("选择可视化")}</h3><VisualizationPicker value={type} onChange={setType}/>
 </Modal>;
}
