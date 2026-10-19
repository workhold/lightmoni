import {useMonitoringI18n} from '../monitoring-i18n';
import { useState } from "react";
import dayjs from "dayjs";
import { CalendarOutlined, ClockCircleOutlined, DownOutlined, LeftOutlined, RightOutlined } from "@ant-design/icons";
import { Alert, Button, DatePicker, InputNumber, Popover, Select, Switch, Tabs, Tooltip } from "../../shared/ui";
import type { TimeRange } from "../../shared/types";
import { timeRange } from "./model";

const presets = [
  [15, "最近 15 分钟"], [30, "最近 30 分钟"], [60, "最近 1 小时"],
  [240, "最近 4 小时"], [1440, "最近 24 小时"], [10080, "最近 7 天"],
] as const;


export default function DiscoverTimeRange({ range, lookback, refreshSeconds, onApply, onRefreshChange }: {
  range: TimeRange;
  lookback: number;
  refreshSeconds: number;
  onApply: (range: TimeRange, lookback: number) => void;
  onRefreshChange: (seconds: number) => void;
}) {
 const {l,language}=useMonitoringI18n();
 const label=(minutes:number)=>{const known=presets.find(([value])=>value===minutes);return known?l(known[1]):minutes>=1440?l("最近 {0} 天",minutes/1440):minutes>=60?l("最近 {0} 小时",minutes/60):l("最近 {0} 分钟",minutes)};

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("relative");
  const [amount, setAmount] = useState<number | null>(15);
  const [unit, setUnit] = useState(1);
  const [absolute, setAbsolute] = useState<TimeRange>(range);
  const [error, setError] = useState("");
  function apply(next: TimeRange, minutes: number) {
    if (!Number.isFinite(Date.parse(next.from)) || !Number.isFinite(Date.parse(next.to)) || Date.parse(next.from) >= Date.parse(next.to)) {
      setError(l("开始时间必须早于结束时间"));
      return;
    }
    setError("");
    onApply(next, minutes);
    setOpen(false);
  }
  function shift(direction: number) {
    const from = Date.parse(range.from), to = Date.parse(range.to), duration = to - from;
    if (Number.isFinite(duration) && duration > 0) apply({
      from: new Date(from + direction * duration).toISOString(),
      to: new Date(to + direction * duration).toISOString(),
    }, 0);
  }
  return <div className="lm-discover-time-controls">
    <Popover trigger="click" placement="bottomRight" open={open} onOpenChange={value => {
      setOpen(value);
      if (value) {
        setAbsolute(range); setError(""); setTab(lookback ? "relative" : "absolute");
        const nextUnit = lookback >= 1440 ? 1440 : lookback >= 60 ? 60 : 1;
        setUnit(nextUnit); setAmount(lookback ? lookback / nextUnit : 15);
      }
    }} classNames={{ root: "lm-discover-time-popover" }} content={<div className="lm-discover-time-panel">
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: "relative", label: l("快速选择"), children: <>
          <div className="lm-discover-relative">
            <span>{l("最近")}</span>
            <InputNumber aria-label={l("相对时间数量")} min={1} max={10080} value={amount} onChange={setAmount} />
            <Select aria-label={l("相对时间单位")} value={unit} onChange={setUnit} options={[{value:1,label:l("分钟")},{value:60,label:l("小时")},{value:1440,label:l("天")}]} />
            <Button type="primary" disabled={!amount} onClick={() => amount && apply(timeRange(amount * unit), amount * unit)}>{l("应用")}</Button>
          </div>
          <div className="lm-discover-time-presets">{presets.map(([minutes, text]) => <Button key={minutes} type="text"
            className={lookback === minutes ? "is-active" : ""} onClick={() => apply(timeRange(minutes), minutes)}>{l(text)}</Button>)}</div>
        </> },
        { key: "absolute", label: l("绝对时间"), children: <div className="lm-discover-absolute">
          <label>{l("开始时间")}<DatePicker showTime format="YYYY-MM-DD HH:mm:ss" allowClear={false} aria-label={l("绝对开始时间")}
            value={dayjs(absolute.from).isValid() ? dayjs(absolute.from) : null}
            onChange={value => value && setAbsolute(current => ({ ...current, from: value.toISOString() }))} /></label>
          <label>{l("结束时间")}<DatePicker showTime format="YYYY-MM-DD HH:mm:ss" allowClear={false} aria-label={l("绝对结束时间")}
            value={dayjs(absolute.to).isValid() ? dayjs(absolute.to) : null}
            onChange={value => value && setAbsolute(current => ({ ...current, to: value.toISOString() }))} /></label>
          <small>{l("使用浏览器所在时区")}</small>
          {error && <Alert type="error" title={error} />}
          <Button type="primary" onClick={() => apply(absolute, 0)}>{l("应用时间范围")}</Button>
        </div> },
      ]} />
      <div className="lm-discover-refresh-setting">
        <ClockCircleOutlined /><span>{l("自动刷新")}</span>
        <Select aria-label={l("刷新间隔")} size="small" value={refreshSeconds || 10} onChange={onRefreshChange}
          options={[{value:10,label:l("10 秒")},{value:30,label:l("30 秒")},{value:60,label:l("1 分钟")}]} />
        <Switch size="small" aria-label={l("启用自动刷新")} checked={refreshSeconds > 0} onChange={enabled => onRefreshChange(enabled ? 10 : 0)} />
      </div>
    </div>}>
      <Button className="lm-log-time-picker" aria-label={l("时间范围")} icon={<CalendarOutlined />}>
        <span>{lookback ? label(lookback) : l("绝对时间范围")}</span><DownOutlined />
      </Button>
    </Popover>
    <Tooltip title={l("上一个时间段")}><Button aria-label={l("上一个时间段")} icon={<LeftOutlined />} onClick={() => shift(-1)} /></Tooltip>
    <Tooltip title={l("下一个时间段")}><Button aria-label={l("下一个时间段")} icon={<RightOutlined />} onClick={() => shift(1)} /></Tooltip>
  </div>;
}
