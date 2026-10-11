import {useState} from 'react';
import {PlusOutlined} from '@ant-design/icons';
import {Button,Modal} from '../../shared/ui';
import VisualizationPicker from './VisualizationPicker';
import {adaptPanelType,newPanel,type Panel} from './model';

export default function AddVisualization({index,onSelect,onClose}:{index:number;onSelect:(panel:Panel)=>void;onClose:()=>void}){
 const [type,setType]=useState('line');
 function create(){onSelect(adaptPanelType(newPanel(undefined,index),type,[]));}
 return <Modal open title="添加可视化" onCancel={onClose} width={740} footer={<><Button onClick={onClose}>取消</Button><Button type="primary" icon={<PlusOutlined aria-hidden/>} onClick={create}>创建图表</Button></>} rootClassName="lm-add-visualization" styles={{body:{maxHeight:'60vh',overflowY:'auto'}}} destroyOnHidden>
  <h3>选择可视化</h3><VisualizationPicker value={type} onChange={setType}/>
 </Modal>;
}
