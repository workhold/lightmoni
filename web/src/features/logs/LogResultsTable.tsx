import { memo, useCallback, useEffect, useMemo, useRef, type MouseEvent, type RefObject } from "react";
import type { ColumnsType, TableRef } from "antd/es/table";
import { RightOutlined } from "@ant-design/icons";
import { Button, Empty, Table, Tag, Tooltip } from "../../shared/ui";
import { cell, initialView, printable, type Filter, type LogRow } from "./model";

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
  selectedID, loading, onSelect, onFilter, onResize, onExpandRange }: Props) {
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const startResize = useCallback((event: MouseEvent, name: string) => {
    event.preventDefault();
    resizeCleanup.current?.();
    const start = event.clientX, width = columnWidth(name, widths);
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
  }, [widths, onResize]);
  const bindScroll = useCallback((element: HTMLDivElement | null) => {
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
  }, []);
  const columns = useMemo<ColumnsType<LogRow>>(() => [
    { key: "detail", title: "", width: 34, shouldCellUpdate: (row, previous) => row !== previous,
      render: (_, row) => <Tooltip title="查看日志详情"><Button type="text" size="small"
        className="lm-log-open-detail" aria-label={`查看日志详情 ${row.event_id}`}
        icon={<RightOutlined />} onClick={() => onSelect(row)} /></Tooltip> },
    ...selectedColumns.map(name => ({
      key: name,
      title: <span className="lm-log-column-title"><span>{name.replace(/^attr:/, "")}</span>
        <span role="separator" tabIndex={0} aria-label={`调整 ${name} 列宽`} aria-orientation="vertical"
          className="lm-log-resize" onMouseDown={event => startResize(event, name)}
          onKeyDown={event => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              onResize(name, columnWidth(name, widths) + (event.key === "ArrowRight" ? 20 : -20));
            }
          }} />
      </span>,
      width: columnWidth(name, widths),
      // Body presentation also depends on rowLines; MessageCell handles that cache.
      shouldCellUpdate: name === "body" ? undefined : (row: LogRow, previous: LogRow) => row !== previous,
      render: (_: unknown, row: LogRow) => name === "body" ? <MessageCell row={row} rowLines={rowLines} onSelect={onSelect} /> :
        name === "severity" || name === "service" ? <button className="lm-log-inline-filter"
          title={name === "severity" ? "按级别筛选" : "按服务筛选"}
          onClick={() => onFilter({ scope: "column", field: name, type: "string", op: "eq", value: row[name] })}>
          {name === "severity" ? <Tag color={severityColor(row.severity)}>{printable(row.severity)}</Tag> : printable(row.service)}
        </button> : <span className="lm-log-cell" title={printable(cell(row, name))}>
          {name === "event_time" ? formatTime(row.event_time) : printable(cell(row, name))}
        </span>,
    })),
  ], [selectedColumns, widths, rowLines, onSelect, onFilter, onResize, startResize]);
  const width = useMemo(() => columns.reduce((sum, column) => sum + Number(column.width), 0), [columns]);
  const scroll = useMemo(() => ({ x: width, y: 480 }), [width]);
  const rowClassName = useCallback((row: LogRow) => row.event_id === selectedID ? "lm-log-active-row" : "", [selectedID]);
  const locale = useMemo(() => ({ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
    description={loading ? "正在查询日志" : <span>没有匹配日志 <Button size="small" type="link"
      onClick={onExpandRange}>扩大到最近 24 小时</Button></span>} /> }), [loading, onExpandRange]);
  return <div ref={bindScroll} className="lm-log-table-scroll" role="region"
    aria-label="日志表格，左右滚动查看所有列" tabIndex={0}>
    <Table<LogRow> ref={tableRef} size="small" virtual style={{ width, maxWidth: "none" }} tableLayout="fixed"
      rowKey="event_id" dataSource={rows} columns={columns} pagination={false} scroll={scroll}
      rowClassName={rowClassName} locale={locale} />
  </div>;
});
