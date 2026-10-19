import {useMonitoringI18n} from '../monitoring-i18n';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import type { ColumnsType, TableRef } from "antd/es/table";
import { ArrowDownOutlined, ArrowUpOutlined, CopyOutlined, DownOutlined, MinusCircleOutlined, MoreOutlined, PlusCircleOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Dropdown, Empty, Table, Tag, Tooltip } from "../../shared/ui";
import { attributeType, cell, fieldType, initialView, printable, type Filter, type LogRow } from "./model";

export const severityColor = (level: unknown) =>
  ({ ERROR: "error", FATAL: "magenta", WARN: "warning", INFO: "success", DEBUG: "default", TRACE: "default" })[String(level)] ?? "default";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
});
function formatTime(value: unknown) {
  const text = String(value), date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : timeFormatter.format(date) + "." +
    (text.match(/\.(\d+)/)?.[1] ?? "0").slice(0, 3).padEnd(3, "0");
}
function columnWidth(name: string, widths: Record<string, number>) {
  return widths[name] ?? initialView.widths[name] ??
    (/_time$|_at$/.test(name) ? 240 : /_id$/.test(name) ? 280 : /json$/.test(name) ? 360 : 200);
}

interface Props {
  tableRef: RefObject<TableRef | null>;
  rows: LogRow[];
  selectedColumns: string[];
  widths: Record<string, number>;
  rowLines: number;
  selectedID?: string;
  loading: boolean;
  onSelect: (row: LogRow) => void;
  onFilter: (filter: Filter) => void;
  onResize: (name: string, width: number) => void;
  onExpandRange: () => void;
  sort: "asc" | "desc";
  onSort: (sort: "asc" | "desc") => void;
  onMoveColumn: (name: string, delta: number) => void;
  onRemoveColumn: (name: string) => void;
  onCopy: (value: string) => void;
  density: "compact" | "comfortable";
}
const MessageCell = memo(function MessageCell({ row, rowLines, onSelect }: {
  row: LogRow; rowLines: number; onSelect: Props["onSelect"];
}) {
  const text = printable(row.body);
  return <div className="lm-log-document"><button
    className={`lm-log-message ${rowLines !== 1 ? "is-wrapped" : ""}`}
    style={rowLines > 1 ? { WebkitLineClamp: rowLines } : undefined}
    title={text} onClick={() => onSelect(row)}
  >{text}</button></div>;
});

// Query drafts, field searches and drawers must not recreate the virtual table.
export default memo(function LogResultsTable({ tableRef, rows, selectedColumns, widths, rowLines,
  selectedID, loading, onSelect, onFilter, onResize, onExpandRange, sort, onSort, onMoveColumn, onRemoveColumn, onCopy, density }: Props) {
 const {l,language}=useMonitoringI18n();

  const resizeCleanup = useRef<(() => void) | null>(null);
  const scrollElement = useRef<HTMLDivElement | null>(null);
  const previousWidths = useRef(widths);
  useEffect(() => { previousWidths.current = widths; }, [widths]);
  const [height, setHeight] = useState(480);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => () => resizeCleanup.current?.(), []);
  useEffect(() => {
    const update = () => { if (scrollElement.current) {
      setHeight(Math.max(160, window.innerHeight - scrollElement.current.getBoundingClientRect().top - 100));
      setContainerWidth(scrollElement.current.clientWidth);
    } };
    const observer = new ResizeObserver(update);
    const main = scrollElement.current?.closest(".lm-log-main");
    if (main) observer.observe(main);
    window.addEventListener("resize", update);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  const startResize = useCallback((event: MouseEvent, name: string) => {
    event.preventDefault();
    resizeCleanup.current?.();
    const start = event.clientX, width = event.currentTarget.closest(".ant-table-cell")?.getBoundingClientRect().width ?? columnWidth(name, widths);
    let next = width, frame = 0;
    const apply = () => { frame = 0; onResize(name, next); };
    const move = (event: globalThis.MouseEvent) => {
      next = width + event.clientX - start;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const cleanup = () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", end);
      resizeCleanup.current = null;
    };
    const end = () => { const pending = frame; cleanup(); if (pending) apply(); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", end);
    resizeCleanup.current = cleanup;
  }, [widths, onResize,language]);
  const bindScroll = useCallback((element: HTMLDivElement | null) => {
    scrollElement.current = element;
    if (!element) return;
    let delta = 0, frame = 0;
    const onWheel = (event: WheelEvent) => {
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!horizontal && !(event.shiftKey && event.deltaY !== 0)) return;
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
      delta += (horizontal ? event.deltaX : event.deltaY) * unit;
      // Capture before the virtual body, and write scroll position once per frame.
      if (!frame) frame = requestAnimationFrame(() => { element.scrollLeft += delta; delta = 0; frame = 0; });
    };
    element.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => { cancelAnimationFrame(frame); element.removeEventListener("wheel", onWheel, true); };
  }, [language]);
  const columns = useMemo<ColumnsType<LogRow>>(() => [
    { key: "detail", title: "", width: 34, shouldCellUpdate: (row, previous) => row !== previous,
      render: (_, row) => <Tooltip title={l("查看日志详情")}><Button type="text" size="small"
        className="lm-log-open-detail" aria-label={l("查看日志详情 {0}",row.event_id)}
        icon={<RightOutlined />} onClick={() => onSelect(row)} /></Tooltip> },
    ...selectedColumns.map((name, index) => ({
      key: name,
      title: <span className="lm-log-column-title"><span>{name.replace(/^attr:/, "")}</span>
        {name === "event_time" && <Button size="small" type="text" className="lm-discover-time-sort" aria-label={l("切换时间排序")}
          icon={sort === "desc" ? <ArrowDownOutlined /> : <ArrowUpOutlined />} onClick={() => onSort(sort === "desc" ? "asc" : "desc")} />}
        <Dropdown trigger={["click"]} menu={{items:[
          ...(name === "event_time" ? [{key:"desc",label:l("按时间降序"),icon:<ArrowDownOutlined />},{key:"asc",label:l("按时间升序"),icon:<ArrowUpOutlined />},{type:"divider" as const}] : []),
          {key:"left",label:l("向左移动"),disabled:index===0},
          {key:"right",label:l("向右移动"),disabled:index===selectedColumns.length-1},
          {key:"remove",label:l("移除此列"),disabled:selectedColumns.length===1},
        ],onClick:({key}) => {if(key==="asc"||key==="desc")onSort(key);else if(key==="remove")onRemoveColumn(name);else onMoveColumn(name,key==="left"?-1:1);}}}>
          <Button size="small" type="text" className="lm-discover-column-menu" aria-label={l("列操作 {0}",name)} icon={<DownOutlined />} />
        </Dropdown>
        <span role="separator" tabIndex={0} aria-label={l("调整 {0} 列宽",name)} aria-orientation="vertical"
          className="lm-log-resize" onMouseDown={event => startResize(event, name)}
          onKeyDown={event => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              onResize(name, columnWidth(name, widths) + (event.key === "ArrowRight" ? 20 : -20));
            }
          }} />
      </span>,
      width: columnWidth(name, widths) + (index === selectedColumns.length - 1
        ? Math.max(0, containerWidth - 34 - selectedColumns.reduce((sum, column) => sum + columnWidth(column, widths), 0)) : 0),
      // Body presentation also depends on rowLines; MessageCell handles that cache.
      shouldCellUpdate: name === "body" ? undefined : (row: LogRow, previous: LogRow) =>
        row !== previous || previousWidths.current[name] !== widths[name],
      render: (_: unknown, row: LogRow) => {
        const value = cell(row, name), scalar = value !== undefined && value !== null && typeof value !== "object";
        const filter: Filter = {scope:name.startsWith("attr:")?"attribute":"column",field:name.replace(/^attr:/,""),
          type:name.startsWith("attr:")?attributeType(row,name.slice(5)):fieldType(value),op:"eq",value};
        return <div className="lm-discover-table-cell"><div className="lm-discover-cell-content">{name === "body" ? <MessageCell row={row} rowLines={rowLines} onSelect={onSelect} /> :
        name === "severity" || name === "service" ? <button className="lm-log-inline-filter"
          title={name === "severity" ? l("按级别筛选") : l("按服务筛选")}
          onClick={() => onFilter({ scope: "column", field: name, type: "string", op: "eq", value: row[name] })}>
          {name === "severity" ? <Tag color={severityColor(row.severity)}>{printable(row.severity)}</Tag> : printable(row.service)}
        </button> : <span className="lm-log-cell" title={printable(cell(row, name))}>
          {name === "event_time" ? formatTime(row.event_time) : printable(cell(row, name))}
        </span>}</div><div className="lm-discover-cell-actions">
          {columnWidth(name,widths) < 150 ? <Dropdown trigger={["click"]} menu={{items:[
            {key:"include",label:l("包含此值"),disabled:!scalar,icon:<PlusCircleOutlined />},
            {key:"exclude",label:l("排除此值"),disabled:!scalar,icon:<MinusCircleOutlined />},
            {key:"copy",label:l("复制值"),icon:<CopyOutlined />},
          ],onClick:({key}) => key==="copy"?onCopy(printable(value)):onFilter({...filter,op:key==="exclude"?"ne":"eq"})}}>
            <Button size="small" type="text" aria-label={l("单元格操作 {0}",name)} icon={<MoreOutlined />} />
          </Dropdown> : <>{scalar && <><Tooltip title={l("包含此值")}><Button size="small" type="text" icon={<PlusCircleOutlined />} aria-label={l("包含单元格 {0}",name)} onClick={() => onFilter(filter)} /></Tooltip>
            <Tooltip title={l("排除此值")}><Button size="small" type="text" icon={<MinusCircleOutlined />} aria-label={l("排除单元格 {0}",name)} onClick={() => onFilter({...filter,op:"ne"})} /></Tooltip></>}
          <Tooltip title={l("复制值")}><Button size="small" type="text" icon={<CopyOutlined />} aria-label={l("复制单元格 {0}",name)} onClick={() => onCopy(printable(value))} /></Tooltip></>}
        </div></div>;
      },
    })),
  ], [selectedColumns, widths, rowLines, onSelect, onFilter, onResize, startResize, sort, onSort, onMoveColumn, onRemoveColumn, onCopy, containerWidth,language]);
  const width = useMemo(() => columns.reduce((sum, column) => sum + Number(column.width), 0), [columns,language]);
  const scroll = useMemo(() => ({ x: width, y: height }), [width, height,language]);
  const rowClassName = useCallback((row: LogRow) => row.event_id === selectedID ? "lm-log-active-row" : "", [selectedID,language]);
  const locale = useMemo(() => ({ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
    description={loading ? l("正在查询日志") : <span>{l("没有匹配日志 ")}<Button size="small" type="link"
      onClick={onExpandRange}>{l("扩大到最近 24 小时")}</Button></span>} /> }), [loading, onExpandRange,language]);
  return <div ref={bindScroll} className={`lm-log-table-scroll ${density === "comfortable" ? "is-comfortable" : ""}`} role="region"
    aria-label={l("日志表格，左右滚动查看所有列")} tabIndex={0}>
    <Table<LogRow> ref={tableRef} size="small" virtual style={{ width, maxWidth: "none" }} tableLayout="fixed"
      rowKey="event_id" dataSource={rows} columns={columns} pagination={false} scroll={scroll}
      rowClassName={rowClassName} locale={locale} />
  </div>;
});
