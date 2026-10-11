import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TableRef } from "antd/es/table";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ApiOutlined,
  CodeOutlined,
  CopyOutlined,
  DownloadOutlined,
  FilterOutlined,
  MessageOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
  ShareAltOutlined,
  MoreOutlined,
  FolderOpenOutlined,
  QuestionCircleOutlined,
  LeftOutlined,
  RightOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Dropdown,
  Popover,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  message,
} from "../../shared/ui";
import { api, post } from "../../shared/api";
import type { CatalogTable, QueryFrame } from "../../shared/types";
import SQLInput from "../../shared/SQLInput";
import { usePublishMonitoringContext } from "../../shared/monitoring-context";
import { AssistantPanel } from "../assistant/AssistantPage";
import Histogram from "./Histogram";
import SearchBox from "./SearchBox";
import FieldAggregate, { TopValues, useFieldAggregate } from "./FieldAggregate";
import { parseExpression } from "./expression";
import JSONTree from "./JSONTree";
import {
  asRows,
  attributes,
  attributeType,
  boundBuffer,
  cell,
  csv,
  fieldType,
  initialSpec,
  initialView,
  logURL,
  readLogURL,
  mergeRows,
  normalizeSpec,
  printable,
  sortRows,
  timeRange,
  type Filter,
  type LogRow,
  type Saved,
  type SearchResult,
  type Spec,
  type View,
} from "./model";
import "./logs.css";

const formatTime = (value: unknown) => {
  const text = String(value);
  const date = new Date(text);
  return Number.isNaN(date.getTime())
    ? text
    : date.toLocaleString() +
        "." +
        (text.match(/\.(\d+)/)?.[1] ?? "0").slice(0, 3).padEnd(3, "0");
};
const severityColor = (level: unknown) =>
  ({
    ERROR: "error",
    FATAL: "magenta",
    WARN: "warning",
    INFO: "success",
    DEBUG: "default",
    TRACE: "default",
  })[String(level)] ?? "default";
const inverse: Record<string, string> = {
  eq: "ne",
  ne: "eq",
  in: "not_in",
  not_in: "in",
  exists: "not_exists",
  not_exists: "exists",
  gt: "lte",
  gte: "lt",
  lt: "gte",
  lte: "gt",
};
const emptyFilter: Filter = {
  scope: "column",
  field: "severity",
  type: "string",
  op: "eq",
  value: "ERROR",
};
interface ContextResult {
  frame: QueryFrame;
  source_id: string;
  scope: string;
  order: string;
  anchor_id: string;
  limit_per_side: number;
}
export default function LogExplorePage() {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width:900px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width:900px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const location = useLocation(),
    navigate = useNavigate(),
    [toast, toastContext] = message.useMessage();
  const [tables, setTables] = useState<CatalogTable[]>([]),
    [catalogReady, setCatalogReady] = useState(false),
    [spec, setSpec] = useState<Spec>(initialSpec()),
    [activeSpec, setActiveSpec] = useState<Spec>(initialSpec());
  const [view, setView] = useState<View>(initialView),
    [result, setResult] = useState<SearchResult>(),
    [rows, setRows] = useState<LogRow[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [fieldsOpen, setFieldsOpen] = useState(false),
    [fieldSearch, setFieldSearch] = useState(""),
    [fieldOpen, setFieldOpen] = useState<string>(),
    [selected, setSelected] = useState<LogRow>(),
    [context, setContext] = useState<ContextResult>(),
    [contextLoading, setContextLoading] = useState(false),
    [contextError, setContextError] = useState(""),
    [contextLimit, setContextLimit] = useState(25);
  const [filterOpen, setFilterOpen] = useState(false),
    [editing, setEditing] = useState<number | null>(null),
    [filter, setFilter] = useState<Filter>(emptyFilter),
    [columnsOpen, setColumnsOpen] = useState(false),
    [sqlOpen, setSQLOpen] = useState(false),
    [aiOpen, setAIOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false),
    [savedList, setSavedList] = useState<Saved[]>([]),
    [saved, setSaved] = useState<Saved>(),
    [saveOpen, setSaveOpen] = useState(false),
    [saveTitle, setSaveTitle] = useState(""),
    [saveBusy, setSaveBusy] = useState(false),
    [deleteTarget, setDeleteTarget] = useState<Saved>();
  const [live, setLive] = useState(false),
    [liveError, setLiveError] = useState(""),
    [pending, setPending] = useState<LogRow[]>([]),
    [dashboardOpen, setDashboardOpen] = useState(false),
    [dashboardTitle, setDashboardTitle] = useState("日志概览"),
    [dashboardBusy, setDashboardBusy] = useState(false);
  const queryPending = useRef(false),
    controller = useRef<AbortController | undefined>(undefined),
    generation = useRef(0),
    tableRef = useRef<TableRef>(null),
    resultArea = useRef<HTMLElement | null>(null),
    previousMode = useRef(view.explore_mode ?? "logs"),
    currentRows = useRef(rows),
    pendingRows = useRef(pending),
    currentResult = useRef(result),
    selectedRow = useRef(selected),
    restoringDetail = useRef(false),
    currentSpec = useRef(activeSpec),
    pollSince = useRef(""),
    polling = useRef(false),
    readAnchor = useRef<string | undefined>(undefined),
    lastLocation = useRef("");
  currentRows.current = rows;
  pendingRows.current = pending;
  currentResult.current = result;
  selectedRow.current = selected;
  currentSpec.current = activeSpec;
  const [brushOrigin, setBrushOrigin] = useState<{
    range: Spec["range"];
    lookback: number;
    interval_ms?: number;
  }>();
  const refreshSeconds = view.refresh_seconds ?? 0;
  const table = tables.find((t) => t.id === spec.table_id),
    activeTable = tables.find((t) => t.id === activeSpec.table_id);
  const selectedForAI =
    selected &&
    new TextEncoder().encode(JSON.stringify(selected)).byteLength > 16000
      ? {
          event_id: selected.event_id,
          event_time: selected.event_time,
          service: selected.service,
          severity: selected.severity,
          trace_id: selected.trace_id,
          body: String(selected.body ?? "").slice(0, 2000),
          context_truncated: true,
        }
      : selected;
  usePublishMonitoringContext({
    table: activeSpec.table_id,
    services: activeSpec.services,
    filters: activeSpec.filters,
    service:
      activeSpec.services.length === 1 ? activeSpec.services[0] : undefined,
    range: activeSpec.range,
    selected_logs: selectedForAI ? [selectedForAI] : undefined,
    log_query: {keyword: activeSpec.keyword, mode: activeSpec.mode, sql: activeSpec.mode === 'sql' ? activeSpec.sql : undefined, params: activeSpec.params, sort: activeSpec.sort, syntax: view.query_syntax},
    status: {loading, error, result_rows: rows.length, truncated: result?.truncated},
  });
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      void toast.success("已复制");
    } catch {
      void toast.error("无法使用剪贴板，请从文本区域手动复制");
    }
  }
  const preserveAnchor = () => {
    const el = tableRef.current?.nativeElement;
    const holder = el?.querySelector(
      ".ant-table-tbody-virtual-holder, .ant-table-body",
    );
    const top = holder?.getBoundingClientRect().top ?? 0;
    const nodes = el?.querySelectorAll<HTMLElement>("[data-row-key]");
    readAnchor.current = nodes
      ? [...nodes].find((n) => n.getBoundingClientRect().bottom > top + 8)
          ?.dataset.rowKey
      : undefined;
  };
  const load = useCallback(async (next: Spec, restore = false) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const seq = ++generation.current;
    queryPending.current = true;
    setLoading(true);
    setError("");
    setLive(false);
    setPending([]);
    setLiveError("");
    if (next.table_id !== currentSpec.current.table_id) {
      setSelected(undefined);
      setContext(undefined);
    }
    try {
      const data = await post<SearchResult & { anchor_found?: boolean }>(
        "/logs/search",
        {
          spec: next,
          limit: 200,
          anchor_id: restore ? readAnchor.current : undefined,
        },
        abort.signal,
      );
      if (seq !== generation.current) return;
      if (restore && data.anchor_found === false && readAnchor.current) {
        setError(
          "阅读锚点不在新查询的有界结果中，继续保留当前结果；可点击查询切换到新结果。",
        );
        return;
      }
      setActiveSpec(next);
      setResult(data);
      setRows(asRows(data.frame));
      pollSince.current = data.generated_at;
      requestAnimationFrame(() => {
        if (restore && readAnchor.current) {
          tableRef.current?.scrollTo({ key: readAnchor.current });
        } else if (!restore) {
          tableRef.current?.scrollTo({ top: 0 });
          // Empty-state focus and previous horizontal browsing can otherwise
          // leave the new result's first non-pinned column behind the time column.
          tableRef.current?.nativeElement
            .querySelector<HTMLElement>(".ant-table-header")
            ?.scrollTo({ left: 0 });
        }
      });
    } catch (err) {
      if (!abort.signal.aborted && seq === generation.current)
        setError((err as Error).message);
    } finally {
      if (seq === generation.current) {
        queryPending.current = false;
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void api<CatalogTable[]>("/catalog/tables", { signal: abort.signal })
      .then((all) => {
        setTables(all.filter((t) => t.kind === "log"));
        setCatalogReady(true);
      })
      .catch((err) => {
        if (!abort.signal.aborted) setError((err as Error).message);
      });
    return () => {
      abort.abort();
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!catalogReady || lastLocation.current === location.key) return;
    lastLocation.current = location.key;
    const params = new URLSearchParams(location.search);
    const state = location.state as {
      logSpec?: Spec;
      logView?: View;
      logSaved?: Saved;
      logSelectedID?: string;
      logQuery?: boolean;
    } | null;
    let next = state?.logSpec
      ? normalizeSpec(state.logSpec)
      : initialSpec(
          params.get("table") ??
            tables.find((t) => t.name === "log_app")?.id ??
            tables[0]?.id ??
            "",
        );
    let linkedView: View | undefined;
    if (!state?.logSpec) {
      try {
        const linked = readLogURL(location.search, next);
        next = linked.spec;
        linkedView = linked.view;
      } catch (err) {
        setError((err as Error).message);
        return;
      }
    }
    if (state?.logView) setView({ ...initialView, ...state.logView });
    else if (linkedView) setView(linkedView);
    else if (params.has("from")) setView((v) => ({ ...v, lookback: 0 }));
    else setView({ ...initialView });
    const savedID = params.get("saved");
    let alive = true;
    const event = params.get("event") ?? state?.logSelectedID;
    const restoreEvent = (s: Spec) => {
      if (!event) {
        setSelected(undefined);
        return;
      }
      if (selectedRow.current?.event_id === event) return;
      restoringDetail.current = true;
      void api<{ frame: QueryFrame }>(
        `/logs/${encodeURIComponent(s.table_id)}/events/${encodeURIComponent(event)}?from=${encodeURIComponent(s.range.from)}&to=${encodeURIComponent(s.range.to)}`,
      )
        .then((data) => {
          if (alive) setSelected(asRows(data.frame)[0]);
        })
        .catch((err) => {
          if (alive) setError((err as Error).message);
        })
        .finally(() => {
          restoringDetail.current = false;
        });
    };
    if (
      state?.logSpec &&
      !state.logQuery &&
      currentResult.current &&
      JSON.stringify(state.logSpec) === JSON.stringify(currentSpec.current)
    ) {
      setSaved(state.logSaved);
      restoreEvent(state.logSpec);
      return () => {
        alive = false;
      };
    }
    if (savedID) {
      queryPending.current = true;
      void api<Saved>(`/logs/saved-searches/${savedID}`)
        .then((item) => {
          if (!alive) return;
          setSaved(item);
          const v = state?.logView ?? { ...initialView, ...item.view };
          setView(v);
          const s = normalizeSpec(
            state?.logSpec ?? {
              ...item.spec,
              range: v.lookback ? timeRange(v.lookback) : item.spec.range,
            },
          );
          setSpec(s);
          void load(s);
          restoreEvent(s);
        })
        .catch((err) => {
          if (alive) {
            queryPending.current = false;
            setError((err as Error).message);
          }
        });
    } else if (next.table_id) {
      setSaved(state?.logSaved);
      setSpec(next);
      void load(next);
      restoreEvent(next);
    }
    return () => {
      alive = false;
    };
    // Navigate entries carry query state; async catalog changes alone do not recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogReady, location.key]);
  useEffect(() => {
    if (!result || restoringDetail.current || queryPending.current) return;
    const old = (location.state ?? {}) as {
      logSpec?: Spec;
      logView?: View;
      logSelectedID?: string;
      logSaved?: Saved;
    };
    if (
      JSON.stringify(old.logView) === JSON.stringify(view) &&
      old.logSelectedID === selected?.event_id &&
      JSON.stringify(old.logSpec) === JSON.stringify(activeSpec) &&
      old.logSaved?.revision === saved?.revision &&
      old.logSaved?.id === saved?.id
    )
      return;
    if (
      window.location.pathname !== location.pathname ||
      window.location.search !== location.search
    )
      return;
    window.history.replaceState(
      {
        ...window.history.state,
        usr: {
          ...old,
          logSpec: activeSpec,
          logView: view,
          logSaved: saved,
          logSelectedID: selected?.event_id,
          logQuery: false,
        },
      },
      "",
    );
  }, [
    view,
    selected,
    result,
    activeSpec,
    saved,
    location.pathname,
    location.search,
    navigate,
  ]);
  function commit(next: Spec, replace = false, nextView = view) {
    setSpec(next);
    setView(nextView);
    navigate(logURL(next, undefined, undefined, nextView), {
      replace,
      state: {
        logSpec: next,
        logView: nextView,
        logSaved: saved,
        logQuery: true,
      },
    });
  }
  function run() {
    try {
      setBrushOrigin(undefined);
      const parsed =
        spec.mode === "filters" && view.query_syntax === "expression"
          ? parseExpression(
              spec.keyword,
              table?.columns ?? [],
              available
                .filter((n) => n.startsWith("attr:"))
                .map((n) => n.slice(5)),
            )
          : { keyword: spec.keyword, filters: [] };
      const filters = [
        ...spec.filters,
        ...parsed.filters.filter(
          (f) =>
            !spec.filters.some(
              (old) => JSON.stringify(old) === JSON.stringify(f),
            ),
        ),
      ];
      commit({
        ...spec,
        keyword: parsed.keyword,
        filters,
        range: view.lookback ? timeRange(view.lookback) : spec.range,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }
  function explore(mode: "logs" | "aggregate", field?: string) {
    if (mode === "aggregate") setLive(false);
    setView((v) => ({
      ...v,
      explore_mode: mode,
      ...(field ? { aggregate_field: field } : {}),
    }));
    setFieldsOpen(false);
  }
  function tabKey(event: React.KeyboardEvent, mode: "logs" | "aggregate") {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "logs"
        : event.key === "End"
          ? "aggregate"
          : mode === "logs"
            ? "aggregate"
            : "logs";
    explore(next);
  }
  useEffect(() => {
    const mode = view.explore_mode ?? "logs";
    if (mode === previousMode.current) return;
    previousMode.current = mode;
    requestAnimationFrame(() => {
      resultArea.current?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
      resultArea.current
        ?.querySelector<HTMLElement>(`[data-mode="${mode}"]`)
        ?.focus({ preventScroll: true });
    });
  }, [view.explore_mode]);
  function quickFilter(f: Filter) {
    setSelected(undefined);
    setFieldsOpen(false);
    commit(
      {
        ...activeSpec,
        filters: [
          ...activeSpec.filters.filter(
            (old) => JSON.stringify(old) !== JSON.stringify(f),
          ),
          f,
        ],
      },
      false,
      { ...view, explore_mode: "logs" },
    );
  }
  function refresh() {
    preserveAnchor();
    const next = {
      ...activeSpec,
      range: view.lookback ? timeRange(view.lookback) : activeSpec.range,
    };
    setSpec(next);
    void load(next, true);
  }
  async function more() {
    if (!result?.next_cursor || loading) return;
    const seq = generation.current;
    setLoading(true);
    try {
      const data = await post<SearchResult>("/logs/search", {
        session_id: result.session_id,
        cursor: result.next_cursor,
        limit: 200,
      });
      if (seq === generation.current) {
        setResult(data);
        setRows((old) => mergeRows(old, asRows(data.frame)));
      }
    } catch (err) {
      if (seq === generation.current) setError((err as Error).message);
    } finally {
      if (seq === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!refreshSeconds || live) return;
    const timer = setInterval(() => {
      preserveAnchor();
      const next = {
        ...currentSpec.current,
        range: view.lookback
          ? timeRange(view.lookback)
          : currentSpec.current.range,
      };
      setSpec(next);
      void load(next, true);
    }, refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [refreshSeconds, live, view.lookback, load]);
  useEffect(() => {
    if (!live) return;
    const abort = new AbortController();
    const seq = generation.current;
    const timer = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      const next = {
        ...currentSpec.current,
        range: view.lookback
          ? timeRange(view.lookback)
          : currentSpec.current.range,
      };
      void post<{
        frame: QueryFrame;
        next_since: string;
        truncated: boolean;
        scope: string;
      }>(
        "/logs/tail",
        { spec: next, since: pollSince.current || new Date().toISOString() },
        abort.signal,
      )
        .then((data) => {
          if (seq !== generation.current || abort.signal.aborted) return;
          if (data.truncated) {
            setLive(false);
            setLiveError("实时窗口结果已截断，请完整重新查询");
            return;
          }
          pollSince.current = data.next_since;
          const existing = new Set(
            currentRows.current.map((row) => row.event_id),
          );
          const incoming = mergeRows(
            pendingRows.current,
            asRows(data.frame).filter((row) => !existing.has(row.event_id)),
            2001,
          );
          if (boundBuffer(incoming).truncated) {
            setLive(false);
            setLiveError(
              "待处理新日志超过 2,000 条 / 8 MiB，已暂停实时；请查看新日志后完整重查",
            );
            return;
          }
          setPending(incoming);
          setLiveError("");
        })
        .catch((err) => {
          if (!abort.signal.aborted) {
            setLive(false);
            setLiveError((err as Error).message);
          }
        })
        .finally(() => {
          polling.current = false;
        });
    }, 3000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [live, view.lookback]);
  const available = useMemo(() => {
    const names = [...(table?.columns.map((c) => c.name) ?? [])];
    for (const row of rows)
      for (const key of Object.keys(attributes(row))) {
        const name = "attr:" + key;
        if (!names.includes(name)) names.push(name);
      }
    return names;
  }, [table, rows]);
  const filteredFields = available.filter((name) =>
    name.toLowerCase().includes(fieldSearch.toLowerCase()),
  );
  const fieldAggregate = useFieldAggregate(
    activeSpec,
    fieldOpen,
    result?.generated_at,
  );
  const aggregationFields = available.filter(
    (name) =>
      name.startsWith("attr:") ||
      [
        "service",
        "severity",
        "instance_id",
        "host_id",
        "source_id",
        "trace_id",
      ].includes(name),
  );
  const displayColumns = narrow
    ? view.columns.filter((name) => ["event_time", "body"].includes(name))
    : view.columns;
  function openFilter(
    index: number | null = null,
    name?: string,
    value?: unknown,
    valueType?: Filter["type"],
  ) {
    setEditing(index);
    if (index !== null) setFilter({ ...spec.filters[index] });
    else {
      const key = name ?? "severity";
      const f: Filter = {
        scope: key.startsWith("attr:") ? "attribute" : "column",
        field: key.replace(/^attr:/, ""),
        type:
          valueType ??
          (!key.startsWith("attr:") &&
          /Int|Float|Decimal/.test(
            table?.columns.find((c) => c.name === key)?.type ?? "",
          )
            ? "number"
            : fieldType(value)),
        op: "eq",
        value: value ?? (key === "severity" ? "ERROR" : ""),
      };
      setFilter(f);
    }
    setFilterOpen(true);
  }
  function applyFilter() {
    if (!filter.field.trim()) {
      void toast.error("请选择过滤字段");
      return;
    }
    let value = filter.value;
    if (["in", "not_in"].includes(filter.op) && typeof value === "string")
      value = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (
      filter.type === "number" &&
      !["exists", "not_exists"].includes(filter.op)
    ) {
      const literal = String(value);
      value =
        /^-?\d+$/.test(literal) && !Number.isSafeInteger(Number(literal))
          ? literal
          : Number(literal);
      if (!String(filter.value).trim() || !Number.isFinite(Number(value))) {
        void toast.error("请输入有限数字");
        return;
      }
    }
    const f = { ...filter, value };
    const filters = [...spec.filters];
    if (editing !== null) filters[editing] = f;
    else filters.push(f);
    setFilterOpen(false);
    commit({ ...spec, filters });
  }
  function updateChip(index: number, action: "disable" | "inverse" | "delete") {
    const filters = spec.filters
      .map((f, i) =>
        i !== index
          ? f
          : action === "disable"
            ? { ...f, disabled: !f.disabled }
            : action === "inverse"
              ? { ...f, op: inverse[f.op] ?? f.op }
              : f,
      )
      .filter((_, i) => action !== "delete" || i !== index);
    commit({ ...spec, filters });
  }
  function toggleColumn(name: string) {
    if (view.columns.length === 1 && view.columns.includes(name)) {
      void toast.info("至少保留一个显示字段");
      return;
    }
    setView((v) => ({
      ...v,
      columns: v.columns.includes(name)
        ? v.columns.filter((c) => c !== name)
        : [...v.columns, name],
    }));
  }
  function moveColumn(index: number, delta: number) {
    setView((v) => {
      const columns = [...v.columns];
      const to = index + delta;
      if (to < 0 || to >= columns.length) return v;
      [columns[index], columns[to]] = [columns[to], columns[index]];
      return { ...v, columns };
    });
  }
  function resize(name: string, width: number) {
    setView((v) => ({
      ...v,
      widths: { ...v.widths, [name]: Math.max(80, Math.min(1200, width)) },
    }));
  }
  function startResize(event: React.MouseEvent, name: string) {
    event.preventDefault();
    const start = event.clientX,
      width = view.widths[name] ?? 180;
    const move = (e: MouseEvent) => resize(name, width + e.clientX - start);
    const end = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", end);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", end);
  }
  const columns = displayColumns.map((name) => ({
    key: name,
    title: (
      <span className="lm-log-column-title">
        <span>{name.replace(/^attr:/, "")}</span>
        <span
          role="separator"
          tabIndex={0}
          aria-label={`调整 ${name} 列宽`}
          aria-orientation="vertical"
          className="lm-log-resize"
          onMouseDown={(e) => startResize(e, name)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              resize(
                name,
                (view.widths[name] ?? 180) +
                  (e.key === "ArrowRight" ? 20 : -20),
              );
            }
          }}
        />
      </span>
    ),
    width: narrow
      ? name === "event_time"
        ? 140
        : 420
      : (view.widths[name] ?? 180),
    fixed:
      !narrow && view.pinned.includes(name) ? ("left" as const) : undefined,
    render: (_: unknown, row: LogRow) =>
      name === "body" ? (
        <div className="lm-log-document">
          {narrow && (
            <small>
              <button
                onClick={() =>
                  quickFilter({
                    scope: "column",
                    field: "service",
                    type: "string",
                    op: "eq",
                    value: row.service,
                  })
                }
              >
                {String(row.service)}
              </button>
              <Tag color={severityColor(row.severity)}>
                {String(row.severity)}
              </Tag>
            </small>
          )}
          <button
            className={`lm-log-message ${(view.row_lines ?? 1) !== 1 ? "is-wrapped" : ""}`}
            style={
              (view.row_lines ?? 1) > 1
                ? { WebkitLineClamp: view.row_lines }
                : undefined
            }
            onClick={() => {
              selectEvent(row);
            }}
            title={printable(row.body)}
          >
            {printable(row.body)}
          </button>
        </div>
      ) : name === "severity" ? (
        <button
          className="lm-log-inline-filter"
          title="按级别筛选"
          onClick={() =>
            quickFilter({
              scope: "column",
              field: "severity",
              type: "string",
              op: "eq",
              value: row.severity,
            })
          }
        >
          <Tag color={severityColor(row.severity)}>
            {printable(row.severity)}
          </Tag>
        </button>
      ) : name === "service" ? (
        <button
          className="lm-log-inline-filter"
          title="按服务筛选"
          onClick={() =>
            quickFilter({
              scope: "column",
              field: "service",
              type: "string",
              op: "eq",
              value: row.service,
            })
          }
        >
          {printable(row.service)}
        </button>
      ) : (
        <span className="lm-log-cell" title={printable(cell(row, name))}>
          {name === "event_time" ? (
            narrow ? (
              <span className="lm-log-time-narrow">
                <span>
                  {new Date(String(row.event_time)).toLocaleDateString(
                    undefined,
                    { month: "2-digit", day: "2-digit" },
                  )}
                </span>
                <time dateTime={String(row.event_time)}>
                  {new Date(String(row.event_time)).toLocaleTimeString(
                    undefined,
                    { hourCycle: "h23" },
                  )}
                  .
                  {(String(row.event_time).match(/\.(\d+)/)?.[1] ?? "0")
                    .slice(0, 3)
                    .padEnd(3, "0")}
                </time>
              </span>
            ) : (
              formatTime(row.event_time)
            )
          ) : (
            printable(cell(row, name))
          )}
        </span>
      ),
  }));

  async function showContext(limit = contextLimit) {
    if (!selected) return;
    setContextLoading(true);
    setContextError("");
    try {
      setContext(
        await post<ContextResult>("/logs/context", {
          spec: activeSpec,
          event_id: selected.event_id,
          limit,
        }),
      );
    } catch (err) {
      setContextError((err as Error).message);
    } finally {
      setContextLoading(false);
    }
  }
  async function refreshSaved() {
    try {
      setSavedList(await api<Saved[]>("/logs/saved-searches"));
    } catch (err) {
      void toast.error((err as Error).message);
    }
  }
  async function save() {
    setSaveBusy(true);
    try {
      const item = await api<Saved>(
        saved ? `/logs/saved-searches/${saved.id}` : "/logs/saved-searches",
        {
          method: saved ? "PUT" : "POST",
          body: JSON.stringify({
            title: saveTitle,
            spec: activeSpec,
            view,
            revision: saved?.revision,
          }),
        },
      );
      setSaved(item);
      setSaveOpen(false);
      void toast.success("检索已保存");
      void refreshSaved();
    } catch (err) {
      void toast.error((err as Error).message);
    } finally {
      setSaveBusy(false);
    }
  }
  async function duplicate(item: Saved) {
    try {
      const created = await post<Saved>("/logs/saved-searches", {
        title: item.title + " 副本",
        spec: item.spec,
        view: item.view,
      });
      await refreshSaved();
      setSavedOpen(false);
      void toast.success("已创建独立检索副本");
      navigate(logURL(created.spec, undefined, created.id));
    } catch (err) {
      void toast.error((err as Error).message);
    }
  }
  function exportCSV() {
    const blob = new Blob(["\ufeff" + csv(rows, view.columns)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs-${activeSpec.table_id}-${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    void toast.info(`已导出当前载入的 ${rows.length} 条日志，非全量数据`);
  }
  function brush(from: string, to: string) {
    setBrushOrigin(
      (old) =>
        old ?? {
          range: activeSpec.range,
          lookback: view.lookback,
          interval_ms: activeSpec.interval_ms,
        },
    );
    commit({ ...activeSpec, range: { from, to } }, false, {
      ...view,
      lookback: 0,
    });
  }
  async function createDashboard() {
    if (!result) return;
    setDashboardBusy(true);
    try {
      const draft = {
        title: dashboardTitle,
        description: "从日志探索创建",
        range: activeSpec.range,
        refresh: 0,
        variables: [],
        panels: [
          {
            id: crypto.randomUUID(),
            title: "日志时间分布",
            type: "bar",
            queries: [
              { refId: "A", sql: result.histogram_sql, params: result.params },
            ],
            options: {
              x: "time",
              y: "count",
              series: "severity",
              stacked: true,
            },
            grid: { x: 0, y: 0, w: 12, h: 8 },
          },
        ],
      };
      const saved = await post<{ id: string }>("/dashboards", draft);
      setDashboardOpen(false);
      navigate("/dashboards/" + saved.id);
    } catch (err) {
      void toast.error((err as Error).message);
    } finally {
      setDashboardBusy(false);
    }
  }
  function alertDraft() {
    if (!result) return;
    const draft = {
      name: `${activeTable?.name ?? activeSpec.table_id} 日志告警`,
      sql: result.count_sql,
      params: result.params,
      source_table_ids: [activeSpec.table_id],
      range: activeSpec.range,
    };
    navigate("/alerts?draft=" + encodeURIComponent(JSON.stringify(draft)), {
      state: { alertDraft: draft },
    });
  }
  const selectedIndex = selected
    ? rows.findIndex((row) => row.event_id === selected.event_id)
    : -1;
  function selectEvent(row: LogRow) {
    setSelected(row);
    setContext(undefined);
    setContextError("");
    setContextLimit(25);
  }
  function fieldKind(name: string) {
    const type =
      table?.columns.find((c) => c.name === name)?.type ??
      (name.startsWith("attr:")
        ? attributeType(
            rows.find(
              (row) => attributes(row)[name.slice(5)] !== undefined,
            ) ?? { event_id: "" },
            name.slice(5),
          )
        : "String");
    return /DateTime/.test(type)
      ? "时间"
      : /Int|Float|Decimal|number/.test(type)
        ? "数字"
        : /Bool|boolean/.test(type)
          ? "布尔"
          : /Map|Array|JSON/.test(type)
            ? "对象"
            : "文本";
  }
  function renderField(name: string) {
    const kind = fieldKind(name);
    return (
      <div
        className={`lm-log-field ${fieldOpen === name ? "selected" : ""}`}
        key={name}
      >
        <button
          title={name}
          aria-expanded={fieldOpen === name}
          onClick={() => setFieldOpen(fieldOpen === name ? undefined : name)}
        >
          <span className="lm-log-field-type" title={kind}>
            {name.startsWith("attr:")
              ? "@"
              : kind === "时间"
                ? "◷"
                : kind === "数字"
                  ? "#"
                  : kind === "对象"
                    ? "{}"
                    : "t"}
          </span>
          <span>{name.replace(/^attr:/, "")}</span>
        </button>
        <Button
          size="small"
          type="text"
          aria-label={`${view.columns.includes(name) ? "移除" : "添加"}列 ${name}`}
          onClick={() => toggleColumn(name)}
        >
          {view.columns.includes(name) ? "−" : "+"}
        </Button>
      </div>
    );
  }
  const normalizedSelected = selected
    ? { ...selected, attributes: attributes(selected) }
    : {};
  const selectedAttributes = selected
    ? Object.entries(attributes(selected))
    : [];
  const fieldSidebar = (
    <>
      <header>
        <b>字段</b>
        <Space size={2}>
          <small>{available.length}</small>
          <Button
            type="text"
            size="small"
            aria-label="收起字段栏"
            icon={<LeftOutlined />}
            onClick={() => setView((v) => ({ ...v, fields_collapsed: true }))}
          />
        </Space>
      </header>
      <Input
        size="small"
        allowClear
        prefix={<SearchOutlined />}
        aria-label="搜索字段"
        placeholder="搜索字段名称"
        value={fieldSearch}
        onChange={(e) => setFieldSearch(e.target.value)}
      />
      {fieldOpen && (
        <div className="lm-log-top-values">
          <header>
            <b>{fieldOpen.replace(/^attr:/, "@ ")}</b>
            <Button
              type="text"
              size="small"
              aria-label="关闭字段统计"
              icon={<CloseOutlined />}
              onClick={() => setFieldOpen(undefined)}
            />
          </header>
          <small>{fieldKind(fieldOpen)} · 当前查询范围 Top 10</small>
          {fieldAggregate.loading ? (
            <Spin size="small" />
          ) : fieldAggregate.error ? (
            <small>{fieldAggregate.error}</small>
          ) : fieldAggregate.data ? (
            <TopValues
              field={fieldOpen}
              data={fieldAggregate.data}
              onFilter={quickFilter}
            />
          ) : null}
          <Button
            size="small"
            type="link"
            onClick={() => explore("aggregate", fieldOpen)}
          >
            查看字段统计
          </Button>
        </div>
      )}
      <div className="lm-log-field-list">
        <div className="lm-log-field-group">
          <b>已选字段</b>
          <small>{view.columns.length}</small>
        </div>
        {view.columns
          .filter((name) =>
            name.toLowerCase().includes(fieldSearch.toLowerCase()),
          )
          .map(renderField)}
        <div className="lm-log-field-group">
          <b>可用字段</b>
          <small>
            {
              filteredFields.filter((name) => !view.columns.includes(name))
                .length
            }
          </small>
        </div>
        {filteredFields
          .filter((name) => !view.columns.includes(name))
          .map(renderField)}
        {!filteredFields.length && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="没有匹配字段"
          />
        )}
      </div>
      <small className="lm-log-field-note">
        属性字段发现于当前已载入日志；Top 值统计覆盖当前查询范围。
      </small>
    </>
  );
  return (
    <div className="lm-page lm-logs-page">
      {toastContext}
      <header className="lm-log-page-heading">
        <div className="lm-log-title">
          <h1>日志探索</h1>
          <span>Discover</span>
          {saved && <Tag>{saved.title}</Tag>}
        </div>
        <Space size={4} wrap>
          <Button
            size="small"
            type="text"
            aria-label="保存的检索"
            icon={<FolderOpenOutlined />}
            onClick={() => {
              setSavedOpen(true);
              void refreshSaved();
            }}
          >
            保存的检索
          </Button>
          <Button
            size="small"
            type="text"
            aria-label="分享检索"
            icon={<ShareAltOutlined />}
            disabled={!result}
            onClick={() =>
              void copy(
                window.location.origin +
                  logURL(activeSpec, undefined, undefined, view),
              )
            }
          >
            分享检索
          </Button>
          <Button
            size="small"
            type="text"
            icon={<MessageOutlined />}
            onClick={() => setAIOpen(true)}
          >
            AI 排查
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<SaveOutlined />}
            disabled={!result}
            onClick={() => {
              setSaveTitle(
                saved?.title ?? `${activeTable?.name ?? "日志"} 检索`,
              );
              setSaveOpen(true);
            }}
          >
            保存检索
          </Button>
        </Space>
      </header>
      <section className="lm-log-query">
        <div className="lm-log-search-line">
          <Select
            showSearch
            optionFilterProp="label"
            aria-label="日志表"
            placeholder="选择日志表"
            value={spec.table_id || undefined}
            className="lm-log-table-picker"
            options={tables.map((t) => ({ value: t.id, label: t.name }))}
            onChange={(id) => {
              setSpec({
                ...spec,
                table_id: id,
                services: [],
                filters: [],
                sql: `SELECT * FROM ${tables.find((t) => t.id === id)?.name ?? id}`,
              });
              setFieldOpen(undefined);
              setSaved(undefined);
            }}
          />
          <Select
            aria-label="检索模式"
            value={
              spec.mode === "sql" ? "sql" : (view.query_syntax ?? "literal")
            }
            className="lm-log-mode-picker"
            options={[
              { value: "literal", label: "正文" },
              { value: "expression", label: "字段表达式" },
              { value: "sql", label: "SQL" },
            ]}
            onChange={(mode) => {
              setLive(false);
              setView((v) => ({
                ...v,
                query_syntax: mode === "expression" ? "expression" : "literal",
              }));
              setSpec({
                ...spec,
                mode: mode === "sql" ? "sql" : "filters",
                sql: spec.sql || `SELECT * FROM ${table?.name ?? "log_app"}`,
              });
            }}
          />
          {spec.mode === "filters" ? (
            <SearchBox
              value={spec.keyword}
              onChange={(keyword) => setSpec({ ...spec, keyword })}
              onRun={run}
              fields={available.filter(
                (name) =>
                  ![
                    "attributes",
                    "resource_json",
                    "attributes_json",
                    "body_json",
                  ].includes(name),
              )}
              expression={view.query_syntax === "expression"}
            />
          ) : (
            <span className="lm-log-sql-hint">按所选时间范围查询原始日志</span>
          )}
          <Select
            aria-label="时间范围"
            value={view.lookback}
            className="lm-log-time-picker"
            options={[
              { value: 15, label: "最近 15 分钟" },
              { value: 60, label: "最近 1 小时" },
              { value: 360, label: "最近 6 小时" },
              { value: 1440, label: "最近 24 小时" },
              { value: 10080, label: "最近 7 天" },
              { value: 0, label: "绝对时间" },
            ]}
            onChange={(lookback) => {
              setView({ ...view, lookback });
              if (lookback) setSpec({ ...spec, range: timeRange(lookback) });
            }}
          />
          <Button
            type="primary"
            aria-label="查询"
            icon={<SearchOutlined />}
            onClick={run}
            disabled={!spec.table_id}
            loading={loading}
          >
            查询
          </Button>
          {loading && (
            <Button
              onClick={() => {
                controller.current?.abort();
                generation.current++;
                queryPending.current = false;
                setLoading(false);
              }}
            >
              取消
            </Button>
          )}
          <Popover
            trigger="click"
            title="检索语法"
            content={
              <div className="lm-log-query-help">
                <p>正文：按原样匹配日志内容，大小写不敏感。</p>
                <p>字段表达式：字段条件会转成可编辑的过滤标签。</p>
                <code>service:checkout-api AND level:ERROR</code>
                <code>@status&gt;=500 @retryable:true</code>
                <p>支持 AND、比较和字段存在（*）。复杂组合使用 SQL。</p>
              </div>
            }
          >
            <Button
              type="text"
              aria-label="检索语法帮助"
              icon={<QuestionCircleOutlined />}
            />
          </Popover>
        </div>
        {view.lookback === 0 && (
          <div className="lm-log-absolute">
            <label>
              开始 UTC
              <Input
                aria-label="开始 UTC"
                value={spec.range.from}
                onChange={(e) =>
                  setSpec({
                    ...spec,
                    range: { ...spec.range, from: e.target.value },
                  })
                }
              />
            </label>
            <label>
              结束 UTC
              <Input
                aria-label="结束 UTC"
                value={spec.range.to}
                onChange={(e) =>
                  setSpec({
                    ...spec,
                    range: { ...spec.range, to: e.target.value },
                  })
                }
              />
            </label>
          </div>
        )}
        <div className="lm-log-controls">
          {result && JSON.stringify(spec) !== JSON.stringify(activeSpec) && (
            <Tag color="processing">条件待应用</Tag>
          )}
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            onClick={() => openFilter()}
            disabled={!spec.table_id}
          >
            添加过滤
          </Button>
          <Select
            mode="multiple"
            maxTagCount="responsive"
            showSearch
            aria-label="服务筛选"
            placeholder="全部服务"
            value={spec.services}
            size="small"
            style={{ width: 210 }}
            options={(table?.services ?? []).map((s) => ({
              label: s,
              value: s,
            }))}
            onChange={(services) => setSpec({ ...spec, services })}
          />
          {spec.mode==='filters'&&<Input size="small" allowClear aria-label="Trace ID 筛选" placeholder="Trace ID" style={{width:190}} value={String(spec.filters.find(filter=>filter.scope==='column'&&filter.field==='trace_id'&&filter.op==='eq')?.value??'')} onChange={event=>setSpec(current=>({...current,filters:[...current.filters.filter(filter=>!(filter.scope==='column'&&filter.field==='trace_id'&&filter.op==='eq')),...(event.target.value?[{scope:'column' as const,field:'trace_id',type:'string' as const,op:'eq' as const,value:event.target.value}]:[])]}))} onPressEnter={run}/>}
          <div className="lm-log-refresh-controls">
            <Select
              aria-label="刷新间隔"
              value={refreshSeconds}
              size="small"
              style={{ width: 115 }}
              options={[
                { value: 0, label: "手动刷新" },
                { value: 10, label: "每 10 秒" },
                { value: 30, label: "每 30 秒" },
                { value: 60, label: "每 1 分钟" },
              ]}
              onChange={(refresh_seconds) =>
                setView((v) => ({ ...v, refresh_seconds }))
              }
            />
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              aria-label="刷新日志"
              onClick={refresh}
              disabled={!result || loading}
            />
          </div>
        </div>
        {spec.mode === "sql" && (
          <SQLInput
            tables={tables.filter((t) => t.id === spec.table_id)}
            value={spec.sql}
            onChange={(sql) => setSpec({ ...spec, sql })}
            height={110}
            onRun={run}
          />
        )}
        <div className="lm-log-chips">
          {spec.filters.map((f, i) => (
            <div
              key={i}
              className={`lm-log-chip ${f.disabled ? "disabled" : ""} ${["ne", "not_in", "not_exists"].includes(f.op) ? "excluded" : ""}`}
            >
              <button onClick={() => openFilter(i)}>
                {f.scope === "attribute" ? "@" : ""}
                {f.field}{" "}
                {{
                  eq: ":",
                  ne: "≠",
                  in: "属于",
                  not_in: "不属于",
                  exists: "存在",
                  not_exists: "缺失",
                  gt: ">",
                  gte: "≥",
                  lt: "<",
                  lte: "≤",
                }[f.op] ?? f.op}{" "}
                {!["exists", "not_exists"].includes(f.op) && printable(f.value)}
              </button>
              <Tooltip title="反转包含/排除">
                <Button
                  size="small"
                  type="text"
                  aria-label={`反转过滤 ${f.field}`}
                  onClick={() => updateChip(i, "inverse")}
                >
                  ±
                </Button>
              </Tooltip>
              <Tooltip title={f.disabled ? "启用" : "禁用"}>
                <Button
                  size="small"
                  type="text"
                  aria-label={`${f.disabled ? "启用" : "禁用"}过滤 ${f.field}`}
                  onClick={() => updateChip(i, "disable")}
                >
                  {f.disabled ? "○" : "●"}
                </Button>
              </Tooltip>
              <Button
                size="small"
                type="text"
                aria-label={`删除过滤 ${f.field}`}
                onClick={() => updateChip(i, "delete")}
              >
                ×
              </Button>
            </div>
          ))}
          {spec.filters.length > 0 && (
            <Button
              size="small"
              type="link"
              aria-label="清除筛选"
              onClick={() =>
                commit({ ...activeSpec, filters: [], services: [] })
              }
            >
              清除
            </Button>
          )}
        </div>
      </section>
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          description="保留了检索条件；上次结果仅供参考。"
          action={<Button onClick={run}>重新查询</Button>}
        />
      )}{" "}
      {liveError && (
        <Alert
          type="warning"
          showIcon
          title={liveError}
          action={<Button onClick={refresh}>完整重查</Button>}
        />
      )}
      {!catalogReady ? (
        <Spin />
      ) : tables.length === 0 ? (
        <Empty description="还没有日志表，请先通过 SDK 或 Agent 上报日志" />
      ) : (
        <>
          <div
            className={`lm-log-workspace ${view.fields_collapsed ? "is-fields-collapsed" : ""}`}
          >
            {!view.fields_collapsed && (
              <aside className="lm-log-fields">{fieldSidebar}</aside>
            )}
            <main className="lm-log-main">
              <div className="lm-log-distribution">
                <div className="lm-log-distribution-heading">
                  <span>日志时间分布</span>
                  {result && !result.histogram_truncated && (
                    <b>
                      {asRows(result.histogram)
                        .reduce((sum, row) => sum + Number(row.count), 0)
                        .toLocaleString()}{" "}
                      条匹配
                    </b>
                  )}
                  <Select
                    size="small"
                    aria-label="时间桶"
                    value={spec.interval_ms ?? 0}
                    style={{ width: 115 }}
                    options={[
                      [0, "自动时间桶"],
                      [1000, "1 秒"],
                      [10000, "10 秒"],
                      [30000, "30 秒"],
                      [60000, "1 分钟"],
                      [300000, "5 分钟"],
                      [900000, "15 分钟"],
                      [3600000, "1 小时"],
                      [86400000, "1 天"],
                    ].map(([value, label]) => ({
                      value: Number(value),
                      label: String(label),
                      disabled:
                        Number(value) > 0 &&
                        (Date.parse(spec.range.to) -
                          Date.parse(spec.range.from)) /
                          Number(value) >
                          2000,
                    }))}
                    onChange={(interval_ms) =>
                      commit({ ...activeSpec, interval_ms })
                    }
                  />
                  <Button
                    size="small"
                    type="text"
                    onClick={() =>
                      setView((v) => ({
                        ...v,
                        chart_collapsed: !v.chart_collapsed,
                      }))
                    }
                  >
                    {view.chart_collapsed ? "展开时间图" : "收起时间图"}
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    onClick={() => {
                      commit(
                        {
                          ...activeSpec,
                          range: brushOrigin?.range ?? timeRange(),
                          interval_ms: brushOrigin?.interval_ms ?? 0,
                        },
                        false,
                        { ...view, lookback: brushOrigin?.lookback ?? 60 },
                      );
                      setBrushOrigin(undefined);
                    }}
                  >
                    {brushOrigin ? "清除时间选择" : "重置时间"}
                  </Button>
                </div>
                {!view.chart_collapsed && (
                  <Histogram
                    frame={result?.histogram}
                    range={result?.range}
                    intervalMS={result?.interval_ms ?? 60000}
                    onRange={brush}
                  />
                )}{" "}
                {result?.histogram_truncated && (
                  <Alert
                    type="warning"
                    title="时间图已截断，请增大桶宽或缩小范围"
                  />
                )}
                {result && (
                  <small className="lm-log-scope">
                    {new Date(result.range.from).toLocaleString()} —{" "}
                    {new Date(result.range.to).toLocaleString()}
                  </small>
                )}
              </div>
              <section ref={resultArea} className="lm-log-results">
                <div className="lm-log-results-toolbar">
                  <Space>
                    <Button
                      className={`lm-log-field-toggle ${view.fields_collapsed ? "is-visible" : ""}`}
                      size="small"
                      icon={<FilterOutlined />}
                      onClick={() =>
                        narrow
                          ? setFieldsOpen(true)
                          : setView((v) => ({ ...v, fields_collapsed: false }))
                      }
                    >
                      字段
                    </Button>
                    <div
                      role="tablist"
                      aria-label="日志结果视图"
                      className="lm-log-result-tabs"
                    >
                      <Button
                        role="tab"
                        aria-label="原始日志"
                        data-mode="logs"
                        aria-selected={view.explore_mode !== "aggregate"}
                        aria-controls="lm-log-document-results"
                        tabIndex={view.explore_mode !== "aggregate" ? 0 : -1}
                        size="small"
                        type={
                          view.explore_mode !== "aggregate" ? "primary" : "text"
                        }
                        onKeyDown={(e) => tabKey(e, "logs")}
                        onClick={() => explore("logs")}
                      >
                        原始日志
                      </Button>
                      <Button
                        role="tab"
                        aria-label="聚合"
                        data-mode="aggregate"
                        aria-selected={view.explore_mode === "aggregate"}
                        aria-controls="lm-log-aggregate-results"
                        tabIndex={view.explore_mode === "aggregate" ? 0 : -1}
                        size="small"
                        type={
                          view.explore_mode === "aggregate" ? "primary" : "text"
                        }
                        onKeyDown={(e) => tabKey(e, "aggregate")}
                        onClick={() => explore("aggregate")}
                      >
                        字段统计
                      </Button>
                    </div>
                    <b>
                      {view.explore_mode === "aggregate"
                        ? "当前查询完整范围"
                        : `${rows.length.toLocaleString()} 条已载入`}
                    </b>
                    {loading && <Spin size="small" />}
                    {view.explore_mode !== "aggregate" && result?.truncated && (
                      <Tag color="warning">
                        结果列表已截断 · 2,000 条 / 8 MiB
                      </Tag>
                    )}
                  </Space>
                  {view.explore_mode !== "aggregate" && (
                    <Space size={6} wrap>
                      <Select
                        size="small"
                        aria-label="日志排序"
                        value={spec.sort}
                        options={[
                          { value: "desc", label: "新 → 旧" },
                          { value: "asc", label: "旧 → 新" },
                        ]}
                        onChange={(sort) => commit({ ...spec, sort })}
                      />
                      <Button
                        size="small"
                        icon={<SettingOutlined />}
                        onClick={() => setColumnsOpen(true)}
                      >
                        列
                      </Button>
                      <Tooltip title="实时每 3 秒读取，查询可见延迟超过 15 秒时需历史刷新">
                        <Button
                          aria-label={live ? "暂停实时" : "实时"}
                          size="small"
                          icon={
                            live ? <PauseOutlined /> : <PlayCircleOutlined />
                          }
                          disabled={!result || spec.mode === "sql"}
                          onClick={() => {
                            setLive((v) => !v);
                            setLiveError("");
                          }}
                        >
                          {live ? "暂停实时" : "实时"}
                        </Button>
                      </Tooltip>
                      <Select
                        aria-label="日志行数"
                        size="small"
                        value={view.row_lines ?? 1}
                        options={[
                          { value: 1, label: "单行" },
                          { value: 3, label: "三行" },
                          { value: 0, label: "自动换行" },
                        ]}
                        onChange={(row_lines) =>
                          setView((v) => ({ ...v, row_lines }))
                        }
                      />
                      <Dropdown
                        trigger={["click"]}
                        menu={{
                          items: [
                            {
                              key: "csv",
                              label: "导出已载入日志 CSV",
                              icon: <DownloadOutlined />,
                              disabled: !rows.length,
                            },
                            {
                              key: "sql",
                              label: "查看执行 SQL",
                              icon: <CodeOutlined />,
                              disabled: !result,
                            },
                            { type: "divider" },
                            {
                              key: "dashboard",
                              label: "加入大盘",
                              disabled: !result,
                            },
                            {
                              key: "alert",
                              label: "创建告警",
                              disabled: !result,
                            },
                          ],
                          onClick: ({ key }) => {
                            if (key === "csv") exportCSV();
                            if (key === "sql") setSQLOpen(true);
                            if (key === "dashboard") setDashboardOpen(true);
                            if (key === "alert") alertDraft();
                          },
                        }}
                      >
                        <Button
                          size="small"
                          type="text"
                          aria-label="更多日志操作"
                          icon={<MoreOutlined />}
                        />
                      </Dropdown>
                    </Space>
                  )}
                </div>
                {view.explore_mode !== "aggregate" && pending.length > 0 && (
                  <button
                    className="lm-log-new"
                    onClick={() => {
                      setRows((old) => {
                        const next = boundBuffer(
                          sortRows(mergeRows(old, pending), activeSpec.sort),
                        );
                        if (next.truncated)
                          void toast.info(
                            "实时列表窗口最多 2,000 条 / 8 MiB，超出的历史日志请重新查询",
                          );
                        return next.rows;
                      });
                      setPending([]);
                      requestAnimationFrame(() =>
                        tableRef.current?.scrollTo({ top: 0 }),
                      );
                    }}
                  >
                    查看 {pending.length} 条新到达日志 · 当前阅读位置保持不变
                  </button>
                )}
                {view.explore_mode === "aggregate" ? (
                  <div
                    role="tabpanel"
                    aria-label="聚合结果"
                    id="lm-log-aggregate-results"
                  >
                    <FieldAggregate
                      spec={activeSpec}
                      fields={aggregationFields}
                      version={result?.generated_at}
                      field={view.aggregate_field ?? "service"}
                      onField={(aggregate_field) =>
                        setView((v) => ({ ...v, aggregate_field }))
                      }
                      expanded
                      onFilter={quickFilter}
                    />
                  </div>
                ) : (
                  <div
                    role="tabpanel"
                    aria-label="原始日志结果"
                    id="lm-log-document-results"
                  >
                    <Table<LogRow>
                      ref={tableRef}
                      size="small"
                      virtual
                      rowKey="event_id"
                      dataSource={rows}
                      columns={[
                        {
                          key: "detail",
                          title: "",
                          width: 34,
                          fixed: "left",
                          render: (_: unknown, row: LogRow) => (
                            <Tooltip title="查看日志详情">
                              <Button
                                type="text"
                                size="small"
                                className="lm-log-open-detail"
                                aria-label={`查看日志详情 ${row.event_id}`}
                                icon={<RightOutlined />}
                                onClick={() => selectEvent(row)}
                              />
                            </Tooltip>
                          ),
                        },
                        ...columns,
                      ]}
                      pagination={false}
                      scroll={{
                        x:
                          34 +
                          displayColumns.reduce(
                            (sum, name) =>
                              sum +
                              (narrow
                                ? name === "event_time"
                                  ? 140
                                  : 420
                                : (view.widths[name] ?? 180)),
                            0,
                          ),
                        y: 480,
                      }}
                      rowClassName={(row) =>
                        row.event_id === selected?.event_id
                          ? "lm-log-active-row"
                          : ""
                      }
                      locale={{
                        emptyText: (
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description={
                              loading ? (
                                "正在查询日志"
                              ) : (
                                <span>
                                  没有匹配日志{" "}
                                  <Button
                                    size="small"
                                    type="link"
                                    onClick={() =>
                                      commit(
                                        {
                                          ...activeSpec,
                                          range: timeRange(1440),
                                          interval_ms: 0,
                                        },
                                        false,
                                        { ...view, lookback: 1440 },
                                      )
                                    }
                                  >
                                    扩大到最近 24 小时
                                  </Button>
                                </span>
                              )
                            }
                          />
                        ),
                      }}
                    />
                  </div>
                )}
                {view.explore_mode !== "aggregate" && (
                  <footer className="lm-log-results-footer">
                    <span>
                      {result
                        ? `会话冻结 ${result.total_loaded.toLocaleString()} 条，${new Date(result.expires_at).toLocaleTimeString()} 过期`
                        : ""}
                    </span>
                    <Button
                      aria-label={
                        result?.next_cursor ? "加载更多" : "已到本次结果末尾"
                      }
                      onClick={() => void more()}
                      loading={loading}
                      disabled={!result?.next_cursor}
                    >
                      {result?.next_cursor ? "加载更多" : "已到本次结果末尾"}
                    </Button>
                  </footer>
                )}
              </section>
            </main>
          </div>
        </>
      )}
      <Drawer
        title="字段探索"
        open={fieldsOpen}
        onClose={() => setFieldsOpen(false)}
        size={340}
      >
        <div className="lm-log-fields-mobile">{fieldSidebar}</div>
      </Drawer>
      <Modal
        title={editing === null ? "添加过滤" : "编辑过滤"}
        open={filterOpen}
        onCancel={() => setFilterOpen(false)}
        onOk={applyFilter}
        okText="应用过滤"
        destroyOnHidden
      >
        <div className="lm-log-form">
          <label>
            字段范围
            <Select
              aria-label="过滤字段范围"
              value={filter.scope}
              options={[
                { value: "column", label: "固定字段" },
                { value: "attribute", label: "自定义属性" },
              ]}
              onChange={(scope) =>
                setFilter({ ...filter, scope, field: "", value: "" })
              }
            />
          </label>
          <label>
            字段
            <Select
              aria-label="过滤字段"
              showSearch
              optionFilterProp="label"
              value={filter.field || undefined}
              options={
                filter.scope === "column"
                  ? (table?.columns ?? [])
                      .filter((c) => !/Map|Array/.test(c.type))
                      .map((c) => ({ value: c.name, label: c.name }))
                  : available
                      .filter((n) => n.startsWith("attr:"))
                      .map((n) => ({ value: n.slice(5), label: n.slice(5) }))
              }
              onChange={(field) => {
                const type =
                  filter.scope === "column" &&
                  /Int|Float|Decimal/.test(
                    table?.columns.find((c) => c.name === field)?.type ?? "",
                  )
                    ? "number"
                    : "string";
                setFilter({
                  ...filter,
                  field,
                  type,
                  value: type === "number" ? 0 : "",
                  op: "eq",
                });
              }}
            />
          </label>
          <label>
            值类型
            <Select
              aria-label="过滤值类型"
              value={filter.type}
              options={[
                { value: "string", label: "字符串" },
                { value: "number", label: "数字" },
                { value: "boolean", label: "布尔" },
              ]}
              onChange={(type) =>
                setFilter({
                  ...filter,
                  type,
                  op: "eq",
                  value: type === "boolean" ? true : type === "number" ? 0 : "",
                })
              }
            />
          </label>
          <label>
            运算符
            <Select
              aria-label="过滤运算符"
              value={filter.op}
              options={[
                ["eq", "等于"],
                ["ne", "不等于"],
                ["in", "包含多个值"],
                ["not_in", "排除多个值"],
                ["exists", "字段存在"],
                ["not_exists", "字段缺失"],
                ...(filter.type === "number"
                  ? [
                      ["gt", "大于"],
                      ["gte", "大于等于"],
                      ["lt", "小于"],
                      ["lte", "小于等于"],
                    ]
                  : []),
              ].map(([value, label]) => ({ value, label }))}
              onChange={(op) => setFilter({ ...filter, op })}
            />
          </label>
          {!["exists", "not_exists"].includes(filter.op) && (
            <label>
              值
              {filter.type === "boolean" ? (
                <Select
                  value={filter.value === true ? "true" : "false"}
                  options={[
                    { value: "true", label: "true" },
                    { value: "false", label: "false" },
                  ]}
                  onChange={(v) =>
                    setFilter({ ...filter, value: v === "true" })
                  }
                />
              ) : (
                <Input
                  type={filter.type === "number" ? "number" : "text"}
                  value={
                    Array.isArray(filter.value)
                      ? filter.value.join(",")
                      : printable(filter.value)
                  }
                  placeholder={
                    ["in", "not_in"].includes(filter.op)
                      ? "用逗号分隔多个值"
                      : ""
                  }
                  onChange={(e) =>
                    setFilter({ ...filter, value: e.target.value })
                  }
                />
              )}
            </label>
          )}
        </div>
      </Modal>
      <Modal
        title="显示列与固定列"
        open={columnsOpen}
        onCancel={() => setColumnsOpen(false)}
        footer={
          <Button type="primary" onClick={() => setColumnsOpen(false)}>
            完成
          </Button>
        }
        width={660}
      >
        <div className="lm-log-columns-config">
          {view.columns.map((name, i) => (
            <div
              key={name}
              draggable
              title="拖动重排列，或使用上移/下移"
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", name);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const moved = e.dataTransfer.getData("text/plain");
                setView((v) => {
                  if (!v.columns.includes(moved) || moved === name) return v;
                  const columns = v.columns.filter((c) => c !== moved);
                  columns.splice(columns.indexOf(name), 0, moved);
                  return { ...v, columns };
                });
              }}
            >
              <b>{name}</b>
              <Checkbox
                checked={view.pinned.includes(name)}
                onChange={(e) =>
                  setView((v) => ({
                    ...v,
                    pinned: e.target.checked
                      ? [...v.pinned, name]
                      : v.pinned.filter((n) => n !== name),
                  }))
                }
              >
                固定
              </Checkbox>
              <Button
                size="small"
                disabled={i === 0}
                onClick={() => moveColumn(i, -1)}
              >
                上移
              </Button>
              <Button
                size="small"
                disabled={i === view.columns.length - 1}
                onClick={() => moveColumn(i, 1)}
              >
                下移
              </Button>
              <Button size="small" onClick={() => toggleColumn(name)}>
                移除
              </Button>
            </div>
          ))}
        </div>
        <Select
          showSearch
          aria-label="添加显示列"
          placeholder="添加显示列"
          value={undefined}
          style={{ width: "100%" }}
          options={available
            .filter((n) => !view.columns.includes(n))
            .map((n) => ({ value: n, label: n }))}
          onChange={toggleColumn}
        />
      </Modal>
      <Drawer
        title={
          <Space>
            <span>日志详情</span>
            <Tag color={severityColor(selected?.severity)}>
              {String(selected?.severity ?? "")}
            </Tag>
          </Space>
        }
        open={!!selected}
        onClose={() => {
          setSelected(undefined);
          setContext(undefined);
        }}
        size="min(850px,95vw)"
        extra={
          <Space size={4}>
            <small>
              {selectedIndex >= 0
                ? `${selectedIndex + 1} / ${rows.length}`
                : "链接日志"}
            </small>
            <Button
              size="small"
              aria-label="上一条日志"
              icon={<LeftOutlined />}
              disabled={selectedIndex <= 0}
              onClick={() => selectEvent(rows[selectedIndex - 1])}
            />
            <Button
              size="small"
              aria-label="下一条日志"
              icon={<RightOutlined />}
              disabled={selectedIndex < 0 || selectedIndex >= rows.length - 1}
              onClick={() => selectEvent(rows[selectedIndex + 1])}
            />
          </Space>
        }
      >
        <Space wrap className="lm-log-detail-actions">
          <Button
            icon={<CopyOutlined />}
            onClick={() => void copy(printable(selected?.body))}
          >
            复制原文
          </Button>
          <Button
            onClick={() =>
              void copy(JSON.stringify(normalizedSelected, null, 2))
            }
          >
            复制 JSON
          </Button>
          <Button
            onClick={() =>
              selected &&
              void copy(
                window.location.origin +
                  logURL(activeSpec, selected.event_id, undefined, view),
              )
            }
          >
            复制链接
          </Button>
          <Button
            loading={contextLoading}
            disabled={!selected?.source_id}
            icon={<ApiOutlined />}
            onClick={() => void showContext()}
          >
            同源上下文
          </Button>
          {selected?.trace_id ? (
            <Button
              onClick={() =>
                navigate(
                  "/logs?table=" + encodeURIComponent(spec.table_id) + "&from=" + encodeURIComponent(activeSpec.range.from) + "&to=" + encodeURIComponent(activeSpec.range.to) + "&trace_id=" +
                    encodeURIComponent(String(selected.trace_id)),
                )
              }
            >
              按 Trace 筛选日志
            </Button>
          ) : null}
          <Button onClick={() => setAIOpen(true)}>AI 分析</Button>
        </Space>
        {selected && (
          <Descriptions
            size="small"
            column={2}
            items={[
              "event_time",
              "ingested_at",
              "service",
              "instance_id",
              "host_id",
              "source_id",
              "source_seq",
              "trace_id",
              "span_id",
            ].map((name) => ({
              key: name,
              label: name,
              children: (
                <span className="lm-log-detail-value">
                  {printable(selected[name])}
                </span>
              ),
            }))}
          />
        )}
        <Tabs
          defaultActiveKey="text"
          items={[
            {
              key: "text",
              label: "原文 / 堆栈",
              children: (
                <pre className="lm-log-body">
                  {printable(selected?.body)}
                  {selectedAttributes
                    .filter(([name]) => /exception|stack/i.test(name))
                    .map(([name, value]) => `\n\n${name}:\n${printable(value)}`)
                    .join("")}
                </pre>
              ),
            },
            {
              key: "json",
              label: "规范化 JSON",
              children: <JSONTree value={normalizedSelected} />,
            },
            {
              key: "fields",
              label: "属性字段",
              children: (
                <Table
                  size="small"
                  pagination={false}
                  dataSource={selectedAttributes.map(([key, value]) => ({
                    key,
                    value,
                  }))}
                  columns={[
                    { title: "字段", dataIndex: "key" },
                    {
                      title: "值",
                      render: (_, r) => <span>{printable(r.value)}</span>,
                    },
                    {
                      title: "操作",
                      render: (_, r) =>
                        r.value !== null && typeof r.value !== "object" ? (
                          <Space size={2}>
                            <Tooltip title="只看此值">
                              <Button
                                size="small"
                                type="text"
                                aria-label={`包含属性 ${r.key}`}
                                icon={<PlusOutlined />}
                                onClick={() =>
                                  quickFilter({
                                    scope: "attribute",
                                    field: r.key,
                                    type: attributeType(selected!, r.key),
                                    op: "eq",
                                    value: r.value,
                                  })
                                }
                              />
                            </Tooltip>
                            <Tooltip title="排除此值">
                              <Button
                                size="small"
                                type="text"
                                aria-label={`排除属性 ${r.key}`}
                                onClick={() =>
                                  quickFilter({
                                    scope: "attribute",
                                    field: r.key,
                                    type: attributeType(selected!, r.key),
                                    op: "ne",
                                    value: r.value,
                                  })
                                }
                              >
                                −
                              </Button>
                            </Tooltip>
                            <Button
                              size="small"
                              type="text"
                              aria-label={`添加属性列 ${r.key}`}
                              onClick={() => toggleColumn("attr:" + r.key)}
                            >
                              列
                            </Button>
                          </Space>
                        ) : null,
                    },
                  ]}
                />
              ),
            },
          ]}
        />
        {contextError && <Alert type="error" title={contextError} />}{" "}
        {context && (
          <section className="lm-log-context">
            <header>
              <b>同源上下文</b>
              <small>{context.scope}</small>
              <Tag>
                {context.order === "source_seq" ? "源输出顺序" : "事件时间顺序"}
              </Tag>
              <Button
                size="small"
                disabled={contextLimit >= 100}
                loading={contextLoading}
                onClick={() => {
                  const next = Math.min(100, contextLimit + 25);
                  setContextLimit(next);
                  void showContext(next);
                }}
              >
                扩大前后范围
              </Button>
            </header>
            {asRows(context.frame).map((row) => (
              <button
                key={row.event_id}
                className={row.event_id === context.anchor_id ? "anchor" : ""}
                onClick={() => {
                  setSelected(row);
                  setContextError("");
                }}
              >
                <time>{String(row.event_time)}</time>
                <Tag color={severityColor(row.severity)}>
                  {String(row.severity)}
                </Tag>
                <span>{String(row.body)}</span>
              </button>
            ))}
          </section>
        )}
      </Drawer>
      <Modal
        title="保存检索"
        okText="保存"
        open={saveOpen}
        onCancel={() => setSaveOpen(false)}
        onOk={() => void save()}
        confirmLoading={saveBusy}
      >
        <label>
          名称
          <Input
            aria-label="检索名称"
            value={saveTitle}
            onChange={(e) => setSaveTitle(e.target.value)}
            onPressEnter={() => void save()}
          />
        </label>
        <p>
          保存当前已执行的查询、时间模式、显示列和固定列。实时状态和会话数据不会保存。
        </p>
        {saved && (
          <Button
            onClick={() => {
              setSaved(undefined);
              setSaveTitle(saveTitle + " 副本");
            }}
          >
            另存为新检索
          </Button>
        )}
      </Modal>
      <Drawer
        title="保存的检索"
        open={savedOpen}
        onClose={() => setSavedOpen(false)}
        size={650}
      >
        <Table<Saved>
          size="small"
          rowKey="id"
          dataSource={savedList}
          pagination={{ pageSize: 10 }}
          columns={[
            {
              title: "名称",
              render: (_, item) => (
                <Button
                  type="link"
                  onClick={() => {
                    setSavedOpen(false);
                    navigate(logURL(item.spec, undefined, item.id));
                  }}
                >
                  {item.title}
                </Button>
              ),
            },
            { title: "表", render: (_, item) => item.spec.table_id },
            {
              title: "操作",
              render: (_, item) => (
                <Space>
                  <Button size="small" onClick={() => void duplicate(item)}>
                    复制
                  </Button>
                  <Button
                    size="small"
                    onClick={() =>
                      void copy(
                        window.location.origin +
                          logURL(item.spec, undefined, item.id),
                      )
                    }
                  >
                    分享
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => setDeleteTarget(item)}
                  >
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Drawer>
      <Modal
        title="删除保存检索"
        open={!!deleteTarget}
        onCancel={() => setDeleteTarget(undefined)}
        onOk={async () => {
          try {
            await api(`/logs/saved-searches/${deleteTarget!.id}`, {
              method: "DELETE",
            });
            if (saved?.id === deleteTarget?.id) setSaved(undefined);
            setDeleteTarget(undefined);
            await refreshSaved();
          } catch (err) {
            void toast.error((err as Error).message);
          }
        }}
        okButtonProps={{ danger: true }}
        okText="删除"
      >
        <p>删除“{deleteTarget?.title}”后，大盘中的独立副本仍保留。</p>
      </Modal>
      <Drawer
        title="实际执行的 SQL"
        open={sqlOpen}
        onClose={() => setSQLOpen(false)}
        size="85vw"
      >
        <Space>
          <Button onClick={() => void copy(result?.sql ?? "")}>复制 SQL</Button>
          <Button
            onClick={() => {
              setSQLOpen(false);
              navigate("/query?sql=" + encodeURIComponent(result?.sql ?? ""), {
                state: {
                  query: {
                    sql: result?.sql,
                    params: result?.params,
                    range: activeSpec.range,
                  },
                },
              });
            }}
          >
            在 SQL 工作台打开
          </Button>
        </Space>
        <SQLInput readOnly value={result?.sql ?? ""} height={300} />
        <h3>参数（独立绑定，未插值）</h3>
        <pre className="lm-log-body">
          {JSON.stringify(result?.params, null, 2)}
        </pre>
        <Alert
          type="info"
          title="日志列表使用有界冻结会话；时间图为完整时间范围内的独立聚合。"
        />
      </Drawer>
      <Modal
        title="加入新大盘"
        open={dashboardOpen}
        onCancel={() => setDashboardOpen(false)}
        onOk={() => void createDashboard()}
        confirmLoading={dashboardBusy}
        okText="创建大盘"
      >
        <Input
          aria-label="大盘名称"
          value={dashboardTitle}
          onChange={(e) => setDashboardTitle(e.target.value)}
        />
        <p>
          使用当前表、服务、过滤和时间生成日志时间图。配置作为独立副本保存。
        </p>
      </Modal>
      <Drawer
        title="AI 日志排查"
        open={aiOpen}
        onClose={() => setAIOpen(false)}
        size="min(820px,95vw)"
        destroyOnHidden
      >
        <AssistantPanel
          compact
          initialContext={{
            page: {path: location.pathname + location.search, title: '日志探索'},
            log_query: {keyword: activeSpec.keyword, mode: activeSpec.mode, sql: activeSpec.mode === 'sql' ? activeSpec.sql : undefined, params: activeSpec.params, sort: activeSpec.sort, syntax: view.query_syntax},
            status: {loading, error, result_rows: rows.length, truncated: result?.truncated},
            table: activeTable?.name,
            services: activeSpec.services,
            filters: activeSpec.filters,
            service:
              activeSpec.services.length === 1
                ? activeSpec.services[0]
                : undefined,
            range: activeSpec.range,
            selected_logs: selected ? [normalizedSelected] : rows.slice(0, 5),
          }}
          initialPrompt="分析当前日志中的异常，区分事实和推测，并给出后续排查 SQL。"
          onSQL={(sql) => {
            setAIOpen(false);
            setSpec((s) => ({ ...s, mode: "sql", sql }));
          }}
        />
      </Drawer>
    </div>
  );
}
