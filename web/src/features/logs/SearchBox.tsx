import {useMonitoringI18n} from '../monitoring-i18n';
import { useState } from "react";
import { SearchOutlined } from "@ant-design/icons";
import { AutoComplete, Input } from "../../shared/ui";

export default function SearchBox({
  value,
  onChange,
  onRun,
  fields,
  expression,
}: {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  fields: string[];
  expression: boolean;
}) {
 const {l,language}=useMonitoringI18n();

  const [open, setOpen] = useState(false);
  const token = value.match(/(?:^|\s)([@\w.]+)$/)?.[1];
  const suggestions =
    expression && token
      ? fields
          .map((name) => name.replace(/^attr:/, "@"))
          .filter((name) => name.toLowerCase().includes(token.toLowerCase()))
          .slice(0, 8)
          .map((name) => ({
            value: value.slice(0, value.length - token.length) + name + ":",
            label: (
              <span className="lm-log-suggestion">
                <code>{name}</code>
                <small>{l("字段筛选")}</small>
              </span>
            ),
          }))
      : [];
  return (
    <AutoComplete
      className="lm-log-search-box"
      value={value}
      options={suggestions}
      open={open && suggestions.length > 0}
      onOpenChange={setOpen}
      onChange={(value) => {
        onChange(value);
        setOpen(true);
      }}
      onSelect={() => setOpen(false)}
    >
      <Input
        allowClear
        aria-label={l("日志关键词")}
        prefix={<SearchOutlined />}
        placeholder={
          expression
            ? l("输入 service:api AND @status>=500，或搜索正文")
            : l("搜索日志正文，支持中文、空格和特殊字符")
        }
        onFocus={() => setOpen(true)}
        onPressEnter={() => {
          if (!open || !suggestions.length) onRun();
        }}
      />
    </AutoComplete>
  );
}
