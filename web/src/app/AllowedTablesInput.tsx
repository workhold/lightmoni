import {useI18n} from '../shared/i18n';
import {Form,Radio,Select} from '../shared/ui';
import type {CatalogTable} from '../shared/types';

export const localizedAllowedTableRules = (t:(zh:string,en:string)=>string = zh=>zh) => [{
  validator: (_: unknown, value?: string[]) => {
    if(value?.some(table=>['lightmoni_center','lightmoni_agent','lightmoni_sdk'].includes(table))) return Promise.reject(new Error(t("系统内置表自动接收内部监控数据，无需配置写入权限","Built-in system tables automatically receive internal monitoring data and require no write permissions")));
    if (!value?.length || value.length > 200) return Promise.reject(new Error(t("请选择 1–200 个允许写入的逻辑 table","Select 1–200 logical tables to allow writes")));
    const invalid = value.find(table => !/^[a-z][a-z0-9_]{0,47}$/.test(table) || /^(log|metric|trace)_/.test(table));
    return invalid ? Promise.reject(new Error(t(`无效的逻辑 table：${invalid}；最长 48 位，小写字母开头，不带 log_/metric_/trace_ 前缀`,`Invalid logical table: ${invalid}. Use up to 48 characters, starting with a lowercase letter, without log_/metric_/trace_ prefixes`))) : Promise.resolve();
  },
}];

export const allowedTableRules=localizedAllowedTableRules();

export function KeyTablePermissions({tables,disabled,help}: {
  tables:CatalogTable[]; disabled?:boolean; help?:string;
}) {
 const {t}=useI18n();

  return <>
    <Form.Item name="allow_all_tables" label={t("上报范围","Reporting scope")}>
      <Radio.Group disabled={disabled} options={[{label:t("指定 table","Selected tables"),value:false},{label:t("所有 table","All tables"),value:true}]}/>
    </Form.Item>
    <Form.Item noStyle shouldUpdate={(previous,current) => previous.allow_all_tables !== current.allow_all_tables}>
      {({getFieldValue}) => getFieldValue('allow_all_tables')
        ? <p>{t("允许写入所有逻辑 table，包括后续新建的 table。","Allow writes to all logical tables, including tables created later.")}</p>
        : <Form.Item name="allowed_tables" label={t("允许写入的 Table","Allowed tables")} rules={localizedAllowedTableRules(t)} extra={help ?? t("填写 SDK 的 table 值，例如 web；对应 log_web、metric_web_*、trace_web。","Enter the SDK table value, such as web, corresponding to log_web, metric_web_*, and trace_web.")}>
          <AllowedTablesInput tables={tables} disabled={disabled}/>
        </Form.Item>}
    </Form.Item>
  </>;
}

export default function AllowedTablesInput({tables,value,onChange,disabled}: {
  tables: CatalogTable[]; value?: string[]; onChange?: (value: string[]) => void; disabled?: boolean;
}) {
 const {t}=useI18n();

  const names = [...new Set(tables.filter(table=>!table.system).map(table => table.logical_name))].sort();
  return <Select
    aria-label={t("允许写入的 Table","Allowed tables")}
    mode="tags"
    style={{width:'100%'}}
    placeholder={t("选择已有 table，或输入新的逻辑表名","Select an existing table or enter a new logical table name")}
    tokenSeparators={[',','，',' ']}
    // Moving keyboard focus must not grant the highlighted table.
    onInputKeyDown={event => { if (event.key === 'Tab') event.stopPropagation(); }}
    value={value}
    onChange={onChange}
    disabled={disabled}
    options={names.map(name => ({label:name,value:name}))}
  />;
}
