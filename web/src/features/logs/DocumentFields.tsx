import { useMemo, useState } from "react";
import { CopyOutlined, MinusCircleOutlined, PlusCircleOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Input, Switch, Table, Tooltip } from "../../shared/ui";
import { attributeType, cell, fieldType, printable, type Filter, type LogRow } from "./model";

export default function DocumentFields({ row, columns, fields, onFilter, onToggleColumn, onCopy }: {
  row: LogRow; columns: string[]; fields: string[];
  onFilter: (filter: Filter) => void; onToggleColumn: (name: string) => void; onCopy: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const data = useMemo(() => fields.filter(name => !selectedOnly || columns.includes(name))
    .map(name => ({ name, value: cell(row, name) }))
    .filter(({name, value}) => `${name} ${printable(value)}`.toLowerCase().includes(search.toLowerCase())), [fields, columns, row, selectedOnly, search]);
  return <div className="lm-discover-document-fields">
    <div className="lm-discover-document-search">
      <Input prefix={<SearchOutlined />} allowClear aria-label="搜索文档字段和值" placeholder="搜索字段和值" value={search} onChange={event => setSearch(event.target.value)} />
      <label><Switch size="small" checked={selectedOnly} onChange={setSelectedOnly} />仅已选字段</label>
    </div>
    <Table size="small" rowKey="name" pagination={false} scroll={{x:620}} dataSource={data} columns={[
      {title:"字段", dataIndex:"name", width:190, render:name => <code>{name.replace(/^attr:/, "")}</code>},
      {title:"值", render:(_, item) => <span className="lm-discover-document-value">{printable(item.value)}</span>},
      {title:"操作", width:130, render:(_, item) => {
        const scalar = item.value !== undefined && item.value !== null && typeof item.value !== "object";
        const filter: Filter = {scope:item.name.startsWith("attr:")?"attribute":"column",field:item.name.replace(/^attr:/,""),
          type:item.name.startsWith("attr:")?attributeType(row,item.name.slice(5)):fieldType(item.value),op:"eq",value:item.value};
        return <div className="lm-discover-document-actions">
          <Tooltip title="包含此值"><Button type="text" size="small" icon={<PlusCircleOutlined />} aria-label={`包含字段 ${item.name}`} disabled={!scalar} onClick={() => onFilter(filter)} /></Tooltip>
          <Tooltip title="排除此值"><Button type="text" size="small" icon={<MinusCircleOutlined />} aria-label={`排除字段 ${item.name}`} disabled={!scalar} onClick={() => onFilter({...filter,op:"ne"})} /></Tooltip>
          <Tooltip title={columns.includes(item.name)?"从表格移除":"添加到表格"}><Button type="text" size="small" aria-label={`切换文档列 ${item.name}`} onClick={() => onToggleColumn(item.name)}>{columns.includes(item.name)?"−":"+"}</Button></Tooltip>
          <Tooltip title="复制值"><Button type="text" size="small" icon={<CopyOutlined />} aria-label={`复制字段 ${item.name}`} onClick={() => onCopy(printable(item.value))} /></Tooltip>
        </div>;
      }},
    ]} />
  </div>;
}
