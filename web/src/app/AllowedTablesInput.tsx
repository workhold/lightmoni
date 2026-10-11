import {Form,Radio,Select} from '../shared/ui';
import type {CatalogTable} from '../shared/types';

export const allowedTableRules = [{
  validator: (_: unknown, value?: string[]) => {
    if (!value?.length || value.length > 200) return Promise.reject(new Error('请选择 1–200 个允许写入的逻辑 table'));
    const invalid = value.find(table => !/^[a-z][a-z0-9_]{0,47}$/.test(table) || /^(log|metric|trace)_/.test(table));
    return invalid ? Promise.reject(new Error(`无效的逻辑 table：${invalid}；最长 48 位，小写字母开头，不带 log_/metric_/trace_ 前缀`)) : Promise.resolve();
  },
}];

export function KeyTablePermissions({tables,disabled,help}: {
  tables:CatalogTable[]; disabled?:boolean; help?:string;
}) {
  return <>
    <Form.Item name="allow_all_tables" label="上报范围">
      <Radio.Group disabled={disabled} options={[{label:'指定 table',value:false},{label:'所有 table',value:true}]}/>
    </Form.Item>
    <Form.Item noStyle shouldUpdate={(previous,current) => previous.allow_all_tables !== current.allow_all_tables}>
      {({getFieldValue}) => getFieldValue('allow_all_tables')
        ? <p>允许写入所有逻辑 table，包括后续新建的 table。</p>
        : <Form.Item name="allowed_tables" label="允许写入的 Table" rules={allowedTableRules} extra={help ?? '填写 SDK 的 table 值，例如 web；对应 log_web、metric_web_*、trace_web。'}>
          <AllowedTablesInput tables={tables} disabled={disabled}/>
        </Form.Item>}
    </Form.Item>
  </>;
}

export default function AllowedTablesInput({tables,value,onChange,disabled}: {
  tables: CatalogTable[]; value?: string[]; onChange?: (value: string[]) => void; disabled?: boolean;
}) {
  const names = [...new Set(tables.map(table => table.logical_name))].sort();
  return <Select
    aria-label="允许写入的 Table"
    mode="tags"
    style={{width:'100%'}}
    placeholder="选择已有 table，或输入新的逻辑表名"
    tokenSeparators={[',','，',' ']}
    // Moving keyboard focus must not grant the highlighted table.
    onInputKeyDown={event => { if (event.key === 'Tab') event.stopPropagation(); }}
    value={value}
    onChange={onChange}
    disabled={disabled}
    options={names.map(name => ({label:name,value:name}))}
  />;
}
