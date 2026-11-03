import {type SSHAccount,type SSHAccountHost,sshCredentialLabel} from './machine-credentials';
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from "../shared/ui";
import { api, ApiError } from "../shared/api";
import SSHCheckSummary, {type SSHCheckResult} from "../shared/SSHCheckSummary";
import { useI18n } from "../shared/i18n";
import {
  defaultMachineCredential,
  reusableMachineCredential,
} from "./machine-credentials";
import {
  agentRuntimePath,
  runtimeCapabilityText,
  runtimeObservation,
  runtimePlanActive,
  runtimePlanPending,
  runtimePlanCanonical,
  runtimePlanExpired,
  runtimePlanMatches,
  type AgentRuntimeMode,
  type AgentRuntimePlan,
  type AgentRuntimeStatus,
} from "./agent-runtime-model";
type Credential = {
  id: string;
  account_id: string;
  username: string;
  account_revision: number;
  secret_fingerprint?: string;
  name?: string;
  method: string;
  retention?: string;
  expires_at?: string;
  revoked_at?: string;
  secret_cleared_at?: string;
  is_default?: boolean;
};
type Host = {
  id: string;
  name: string;
  agent_id?: string;
  agent_status?: string;
  default_account_id?: string;
  accounts?: SSHAccount[];
};

export default function AgentRuntimePanel({
  machine,
  credentials,
  onChanged,
  onStatus,
  onManageAccounts,
}: {
  machine: Host;
  credentials: Credential[];
  onChanged?: () => Promise<void>;
  onStatus?: (status: AgentRuntimeStatus | undefined) => void;
  onManageAccounts?: (onVerified?:(result:SSHCheckResult)=>void) => void;
}) {
  const { t, language } = useI18n();
  const [status, setStatus] = useState<AgentRuntimeStatus>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [preflight,setPreflight]=useState<SSHCheckResult>();
  const [credential, setCredential] = useState<string>(),
    [reconcileCredential, setReconcileCredential] = useState<string>(),
    [target, setTarget] = useState<AgentRuntimeMode>("root"),
    [records, setRecords] = useState<AgentRuntimePlan[]>([]),
    [record, setRecord] = useState<AgentRuntimePlan>(),
    [reviewed, setReviewed] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [recordVerified, setRecordVerified] = useState(true),
    [now, setNow] = useState(Date.now());
  const generation = useRef(0),
    mounted = useRef(true),
    pending = useRef(false),
    attempted = useRef(false),
    requestID = useRef(""),
    preparing = useRef<
      | {
          ids: Set<string>;
          mode: AgentRuntimeMode;
          credential: string;
          from: AgentRuntimeMode;
          generation: number;
        }
      | undefined
    >(undefined),
    statusCallback = useRef(onStatus);
  statusCallback.current = onStatus;
  const valid = (id: number) => mounted.current && generation.current === id;
  const keys = credentials.filter((value) => reusableMachineCredential(value));
  const base = agentRuntimePath(machine.id),
    failure = (e: unknown) =>
      e instanceof Error ? e.message === "root_or_sudo_ssh_required" ? t("当前 SSH 账户没有安装 Agent 或切换管理模式所需权限，请选择其他已登记账户重新检查，或添加登录账户。", "The current SSH account lacks Agent installation or management-mode privileges. Select another registered account and check again, or add a login account.") : e.message : t("操作失败", "Operation failed");
  const modeName = (mode?: AgentRuntimeMode | null) =>
    mode === "root"
      ? t("完整管理 · 已安装 root 管理组件", "Full management · root management component installed")
      : mode === "user"
        ? t("仅监控 · 未安装 root 管理组件", "Monitoring only · no root management component")
        : t("尚未验证", "Not verified");
  const stateName = (s: string) =>
    ({
      awaiting_approval: t("待审阅", "Awaiting review"),
      running: t("正在切换", "Switching"),
      verifying: t(
        "等待管理模式和心跳验证",
        "Awaiting management mode and heartbeat verification",
      ),
      succeeded: t("已切换并验证", "Switched and verified"),
      failed: t("切换失败", "Switch failed"),
      unknown: t("结果未知，仅可核对", "Outcome unknown; verification only"),
      cancelled: t("已取消", "Cancelled"),
    })[s] || s;
  const stamp = (v?: string) =>
    v && Number.isFinite(Date.parse(v))
      ? new Date(v).toLocaleString(language)
      : "—";
  const validateStatus = (next: AgentRuntimeStatus) => {
    if (
      next.machine_id !== machine.id ||
      next.agent_id !== machine.agent_id ||
      (next.runtime_mode !== null &&
        !["root", "user"].includes(next.runtime_mode)) ||
      !Number.isSafeInteger(next.permission_generation) ||
      next.permission_generation < 0 ||
      (next.observed_runtime !== null &&
        !runtimeObservation(next.observed_runtime)) ||
      (next.maintenance && !runtimePlanMatches(next.maintenance, machine))
    )
      throw Error(
        t(
          "运行状态与目标主机不匹配，请刷新",
          "Runtime status does not match this host. Refresh it.",
        ),
      );
    return next;
  };
  const load = async (background = false) => {
    if (pending.current) return;
    const id = ++generation.current;
    if (!background) setLoading(true);
    try {
      const next = validateStatus(await api<AgentRuntimeStatus>(base));
      if (!valid(id)) return;
      setStatus(next);
      statusCallback.current?.(next);
      if (!background) setError("");
    } catch (e) {
      if (valid(id)) {
        setStatus(undefined);
        statusCallback.current?.(undefined);
        if (!background) setError(failure(e));
      }
    } finally {
      if (valid(id)) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    setStatus(undefined);
    statusCallback.current?.(undefined);
    if (machine.agent_id) void load();
    else setLoading(false);
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [machine.id, machine.agent_id]);
  useEffect(() => {
    if (!machine.agent_id) return;
    const timer = setInterval(() => void load(true), 15000);
    return () => clearInterval(timer);
  }, [machine.id, machine.agent_id]);
  useEffect(() => {
    if (credential && !keys.some((v) => v.id === credential)) {
      setCredential(undefined);
      setReviewed(false);
    }
  }, [credentials, credential]);
  useEffect(() => {
    if (record?.status === "unknown")
      setReconcileCredential(
        keys.some((v) => v.id === record.plan.credential_id)
          ? record.plan.credential_id
          : undefined,
      );
    else setReconcileCredential(undefined);
  }, [record?.id, record?.status]);
  useEffect(() => {
    if (reconcileCredential && !keys.some((v) => v.id === reconcileCredential))
      setReconcileCredential(undefined);
  }, [credentials, reconcileCredential]);
  useEffect(() => {
    if (!record) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [record?.id]);
  const keep = (next: AgentRuntimePlan) => {
    if (!runtimePlanMatches(next, machine))
      throw Error(
        t(
          "运行模式计划与目标主机不匹配",
          "Runtime plan does not match this host",
        ),
      );
    setRecordVerified(true);
    setRecord(next);
    setRecords((previous) => [
      next,
      ...previous.filter((v) => v.id !== next.id),
    ]);
    setReviewed(false);
  };
  const list = async () => {
    const next = await api<AgentRuntimePlan[]>(base + "/plans");
    if (
      !Array.isArray(next) ||
      next.some((v) => !runtimePlanMatches(v, machine))
    )
      throw Error(t("运行模式记录格式无效", "Invalid runtime mode records"));
    return next;
  };
  const show = async () => {
    if (pending.current) return;
    setOpen(true);
    setError("");
    setPreflight(undefined);
    setReviewed(false);
    setRecord(undefined);
    setRecordVerified(true);
    setUncertain(false);
    attempted.current = false;
    preparing.current = undefined;
    setCredential(
      defaultMachineCredential(
        credentials,
        machine,
        reusableMachineCredential,
      ),
    );
    setTarget(status?.runtime_mode === "root" ? "user" : "root");
    pending.current = true;
    setBusy(true);
    const id = ++generation.current;
    try {
      const next = await list();
      if (!valid(id)) return;
      setRecords(next);
      const active = next.find((v) => runtimePlanActive(v.status));
      if (active) {
        keep(active);
        setTarget(active.plan.runtime_mode);
        setCredential(active.plan.credential_id);
        attempted.current = runtimePlanPending(active.status);
        requestID.current = crypto.randomUUID();
      }
    } catch (e) {
      if (valid(id)) setError(failure(e));
    } finally {
      pending.current = false;
      if (valid(id)) setBusy(false);
    }
  };
  const refresh = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const id = ++generation.current;
    try {
      if (record) {
        const next = await api<AgentRuntimePlan>(
          base + "/plans/" + encodeURIComponent(record.id),
        );
        if (!valid(id)) return;
        if (
          next.id !== record.id ||
          next.revision !== record.revision ||
          runtimePlanCanonical(next.plan) !== runtimePlanCanonical(record.plan)
        )
          throw Error(
            t(
              "返回记录与原计划不匹配",
              "Returned record differs from the original plan",
            ),
          );
        keep(next);
        setUncertain(false);
        if (next.status === "succeeded") await onChanged?.();
      } else {
        const next = await list();
        if (!valid(id)) return;
        setRecords(next);
        const p = preparing.current;
        if (p) {
          const candidates = next.filter(
            (v) =>
              !p.ids.has(v.id) &&
              v.plan.runtime_mode === p.mode &&
              v.plan.credential_id === p.credential &&
              v.plan.from_mode === p.from &&
              v.plan.previous_generation === p.generation,
          );
          if (candidates.length === 1) {
            keep(candidates[0]);
            preparing.current = undefined;
            setUncertain(false);
            requestID.current = crypto.randomUUID();
          } else setUncertain(true);
        }
      }
    } catch (e) {
      if (valid(id)) {
        setError(failure(e));
        setRecordVerified(false);
      }
    } finally {
      pending.current = false;
      if (valid(id)) {
        setBusy(false);
        void load(true);
      }
    }
  };
  const prepare = async () => {
    if (
      pending.current ||
      !credential ||
      !status?.runtime_mode ||
      preparing.current ||
      (status.maintenance && runtimePlanActive(status.maintenance.status))
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    setPreflight(undefined);
    setReviewed(false);
    attempted.current = false;
    const id = ++generation.current;
    let sent = false;
    try {
      const before = await list();
      if (!valid(id)) return;
      setRecords(before);
      const active = before.find((v) => runtimePlanActive(v.status));
      if (active) {
        keep(active);
        attempted.current = runtimePlanPending(active.status);
        setTarget(active.plan.runtime_mode);
        setCredential(active.plan.credential_id);
        requestID.current = crypto.randomUUID();
        return;
      }
      preparing.current = {
        ids: new Set(before.map((v) => v.id)),
        mode: target,
        credential,
        from: status.runtime_mode,
        generation: status.permission_generation,
      };
      sent = true;
      const next = await api<AgentRuntimePlan>(base + "/plans", {
        method: "POST",
        body: JSON.stringify({
          runtime_mode: target,
          credential_id: credential,
        }),
      });
      if (!valid(id)) return;
      if (
        !runtimePlanMatches(next, machine) ||
        next.plan.runtime_mode !== target ||
        next.plan.from_mode !== status.runtime_mode ||
        next.plan.previous_generation !== status.permission_generation ||
        next.plan.credential_id !== credential
      )
        throw Error(
          t(
            "返回计划与选择的账户或当前权限代次不匹配",
            "The plan does not match the chosen account or current permission generation",
          ),
        );
      keep(next);
      sent = false;
      preparing.current = undefined;
      requestID.current = crypto.randomUUID();
    } catch (e) {
      if (valid(id)) {
        setError(failure(e));
        if(e instanceof ApiError&&e.details.preflight){const checked=e.details.preflight as SSHCheckResult;const selected=keys.find(c=>c.id===credential);if(checked.machine_id===machine.id&&checked.credential_id===credential&&selected&&checked.account_id===selected.account_id&&checked.username===selected.username&&checked.account_revision===selected.account_revision)setPreflight(checked)}
        if (sent && !(e instanceof ApiError && e.status < 500))
          setUncertain(true);
        else preparing.current = undefined;
      }
    } finally {
      pending.current = false;
      if (valid(id)) setBusy(false);
    }
  };
  const apply = async () => {
    if (
      pending.current ||
      !record ||
      !reviewed ||
      attempted.current ||
      runtimePlanExpired(record) ||
      !recordVerified ||
      !keys.some((v) => v.id === record.plan.credential_id)
    )
      return;
    pending.current = true;
    attempted.current = true;
    setBusy(true);
    setError("");
    const id = ++generation.current;
    try {
      requestID.current ||= crypto.randomUUID();
      const next = await api<AgentRuntimePlan>(
        base + "/plans/" + encodeURIComponent(record.id) + "/apply",
        {
          method: "POST",
          body: JSON.stringify({
            confirm: true,
            expected_revision: record.revision,
            request_id: requestID.current,
          }),
        },
      );
      if (!valid(id)) return;
      if (
        next.id !== record.id ||
        next.revision !== record.revision ||
        runtimePlanCanonical(next.plan) !== runtimePlanCanonical(record.plan)
      )
        throw Error(
          t(
            "执行回执与原计划不匹配",
            "Execution receipt differs from the original plan",
          ),
        );
      keep(next);
      if (next.status === "succeeded") await onChanged?.();
    } catch (e) {
      if (valid(id)) {
        setError(failure(e));
        setRecordVerified(false);
        setReviewed(false);
        setUncertain(true);
      }
    } finally {
      pending.current = false;
      if (valid(id)) {
        setBusy(false);
        void load(true);
      }
    }
  };
  useEffect(() => {
    if (!open || !record || !["running", "verifying"].includes(record.status))
      return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [open, record?.id, record?.status]);
  const cancel = async () => {
    if (pending.current || !record || record.status !== "awaiting_approval")
      return;
    pending.current = true;
    setBusy(true);
    setReviewed(false);
    setError("");
    const id = ++generation.current;
    try {
      const next = await api<AgentRuntimePlan>(
        base + "/plans/" + encodeURIComponent(record.id) + "/cancel",
        { method: "POST", body: JSON.stringify({ confirm: true }) },
      );
      if (!valid(id)) return;
      if (
        next.id !== record.id ||
        next.revision !== record.revision ||
        runtimePlanCanonical(next.plan) !== runtimePlanCanonical(record.plan) ||
        next.status !== "cancelled"
      )
        throw Error(
          t(
            "取消回执与原计划不匹配",
            "Cancellation receipt differs from the original plan",
          ),
        );
      keep(next);
      setUncertain(false);
    } catch (e) {
      if (valid(id)) {
        setError(failure(e));
        setRecordVerified(false);
      }
    } finally {
      pending.current = false;
      if (valid(id)) {
        setBusy(false);
        void load(true);
      }
    }
  };
  const reconcile = async () => {
    if (
      pending.current ||
      !record ||
      record.status !== "unknown" ||
      !recordVerified ||
      !keys.some((v) => v.id === reconcileCredential)
    )
      return;
    pending.current = true;
    setBusy(true);
    setReviewed(false);
    setError("");
    const id = ++generation.current;
    try {
      const next = await api<AgentRuntimePlan>(
        base + "/plans/" + encodeURIComponent(record.id) + "/reconcile",
        {
          method: "POST",
          body: JSON.stringify({ credential_id: reconcileCredential }),
        },
      );
      if (!valid(id)) return;
      if (
        next.id !== record.id ||
        next.revision !== record.revision ||
        runtimePlanCanonical(next.plan) !== runtimePlanCanonical(record.plan)
      )
        throw Error(
          t(
            "核对回执与原计划不匹配",
            "Reconciliation receipt differs from the original plan",
          ),
        );
      keep(next);
      setUncertain(false);
      if (["succeeded", "failed"].includes(next.status)) await onChanged?.();
    } catch (e) {
      if (valid(id)) {
        setError(failure(e));
        setRecordVerified(false);
      }
    } finally {
      pending.current = false;
      if (valid(id)) {
        setBusy(false);
        void load(true);
      }
    }
  };
  const actual = runtimeObservation(status?.observed_runtime),
    expired = !!record && runtimePlanExpired(record, now),
    credentialValid =
      !!record && keys.some((v) => v.id === record.plan.credential_id);
  return (
    <section aria-label={t("Agent 权限模式", "Agent permission mode")}>
      <Space wrap>
        <h3>{t("Agent 权限模式", "Agent permission mode")}</h3>
        {machine.agent_id && (
          <Button
            size="small"
            loading={loading}
            disabled={busy}
            onClick={() => void load()}
          >
            {t("刷新运行状态", "Refresh runtime status")}
          </Button>
        )}
      </Space>
      <Descriptions
        size="small"
        column={{ xs: 1, sm: 2 }}
        items={[
          {
            key: "mode",
            label: t("管理模式", "Management mode"),
            children: machine.agent_id
              ? modeName(status?.runtime_mode)
              : t("尚未安装", "Not installed"),
          },
          {
            key: "observed",
            label: t("Agent 常驻进程身份", "Agent daemon process identity"),
            children: actual ? (
              <Space>
                <Tag color={status?.online ? "success" : "default"}>
                  {status?.online ? t("在线", "Online") : t("离线", "Offline")}
                </Tag>
                {`UID ${actual.uid} / GID ${actual.gid}`}
              </Space>
            ) : (
              t("等待有效心跳", "Waiting for a verified heartbeat")
            ),
          },
          {
            key: "generation",
            label: t("权限配置代次", "Permission generation"),
            children: status?.permission_generation || "—",
          },
          {
            key: "service",
            label: t("服务", "Service"),
            children: "lightmoni-agent.service",
          },
        ]}
      />
      <Typography.Paragraph type="secondary">
        {t(
          "Agent 常驻服务始终以 lightmoni-agent 非 root 账户运行。完整管理模式另安装同版本 root 管理组件，作为单独受管服务运行；普通脚本固定降权至 lightmoni-task 执行。仅监控模式不领取自定义脚本。Agent 与管理组件使用同一升级和卸载流程。",
          "The resident Agent service always runs unprivileged as lightmoni-agent. Full management adds a version-matched root management component as a separately managed service; ordinary scripts run as lightmoni-task. Monitoring-only mode does not accept custom scripts. The Agent and management component share one upgrade and uninstall lifecycle.",
        )}
      </Typography.Paragraph>
      {error && !open && <Alert type="error" showIcon title={error} />}
      {machine.agent_id && (
        <Button
          disabled={loading || busy || !status?.runtime_mode}
          onClick={() => void show()}
        >
          {status?.maintenance && runtimePlanActive(status.maintenance.status)
            ? t("查看权限模式切换记录", "View permission mode change")
            : status?.runtime_mode === "root"
              ? t("切换为仅监控", "Switch to monitoring only")
              : t("启用完整管理", "Enable full management")}
        </Button>
      )}
      {open && (
        <Modal
          open
          width={780}
          title={t("切换 Agent 权限模式", "Switch Agent permission mode")}
          maskClosable={false}
          keyboard={!busy}
          closable={!busy}
          onCancel={() => {
            if (!busy) setOpen(false);
          }}
          footer={
            <Button disabled={busy} onClick={() => setOpen(false)}>
              {t("关闭", "Close")}
            </Button>
          }
        >
          <Typography.Paragraph>
            {t(
              "通过已登记主机的 root 或免交互 sudo SSH 凭据切换 Agent 权限模式。Agent 常驻服务始终由 lightmoni-agent 非 root 账户运行；完整管理模式会安装或移除同版本、独立受管的 root 管理组件，普通脚本固定以 lightmoni-task 执行，仅监控模式拒绝自定义脚本。保留主机和 Agent ID；升级保留当前模式，切换不会扩大已有任务授权。启用的容器管理、高权限脚本和受管主机操作仍逐项审阅、批准并留审计。",
              "Use the registered host’s root or non-interactive sudo SSH credential to switch Agent permission modes. The resident Agent service always runs as the unprivileged lightmoni-agent account; full management installs or removes a version-matched, separately managed root component, ordinary scripts run as lightmoni-task, and monitoring-only mode rejects custom scripts. Host and Agent IDs are retained; upgrades keep the current mode, and switching never expands existing task authorization. Container management, elevated scripts, and managed host operations remain individually reviewed, approved, and audited.",
            )}
          </Typography.Paragraph>
          <Alert
            className="lm-machine-form-notice"
            type="info"
            showIcon
            title={t(
              "切换前确认待发送缓存已清空",
              "Confirm unsent caches are drained before switching",
            )}
            description={t(
              "主机、Agent ID 和运维业务数据保持不变。遥测队列与配置缓存按维护流程隔离并重新加载；仅监控模式不会保留脚本派发权限。",
              "Host, Agent ID, and operations data are retained. Telemetry queues and configuration caches are isolated and reloaded through the maintenance workflow; monitoring-only mode does not retain script-dispatch permission.",
            )}
          />
          {error && (
            <Alert
              className="lm-machine-form-notice"
              type="error"
              showIcon
              title={error}
            />
          )}
          {uncertain && (
            <Alert
              className="lm-machine-form-notice"
              type="warning"
              showIcon
              title={t(
                "结果尚未确认，请只读查询原记录",
                "Outcome unconfirmed; read the original record only",
              )}
              description={t(
                "不会重复创建或下发切换操作。核对期间保留原计划和维护门禁。",
                "The switch is not created or dispatched again. Its plan and maintenance fence remain available for verification.",
              )}
            />
          )}
          {!record ? (
            <>
              {onManageAccounts&&<Button disabled={busy||uncertain} onClick={()=>{setOpen(false);onManageAccounts(result=>{setReconcileCredential(result.credential_id);setCredential(result.credential_id);setPreflight(undefined);setError("");setOpen(true)})}}>{t("管理或添加登录账户","Manage or add login accounts")}</Button>}
              {preflight&&<SSHCheckSummary result={preflight} onChooseAccount={id=>{if(keys.some(c=>c.id===id)){setCredential(id);setPreflight(undefined);setError("")}}} onManageAccounts={onManageAccounts?()=>{setOpen(false);onManageAccounts(result=>{setReconcileCredential(result.credential_id);setCredential(result.credential_id);setPreflight(undefined);setError("");setOpen(true)})}:undefined}/>}
              <Descriptions
                column={1}
                size="small"
                items={[
                  {
                    key: "from",
                    label: t("当前管理模式", "Current management mode"),
                    children: modeName(status?.runtime_mode),
                  },
                  {
                    key: "target",
                    label: t("目标管理模式", "Target management mode"),
                    children: modeName(target),
                  },
                ]}
              />
              <Select
                aria-label={t(
                  "切换模式使用的 SSH 凭据",
                  "SSH credential for mode change",
                )}
                style={{ width: "100%" }}
                value={credential}
                disabled={busy || uncertain}
                onChange={setCredential}
                options={keys.map((v) => ({
                  value: v.id,
                  label: sshCredentialLabel(v),
                }))}
                placeholder={t(
                  "选择有效 root / sudo SSH 凭据",
                  "Select an active root / sudo SSH credential",
                )}
              />
              <Space wrap className="lm-machine-form-notice">
                <Button
                  type="primary"
                  disabled={!credential || uncertain || loading}
                  loading={busy}
                  onClick={() => void prepare()}
                >
                  {t(
                    "检查并生成模式切换计划",
                    "Check and create mode change plan",
                  )}
                </Button>
                <Button disabled={busy} onClick={() => void refresh()}>
                  {t("只读查询切换记录", "Read switch records")}
                </Button>
              </Space>
            </>
          ) : (
            <>
              <Descriptions
                column={1}
                size="small"
                items={[
                  {
                    key: "id",
                    label: t("计划 ID", "Plan ID"),
                    children: record.id,
                  },
                  {
                    key: "status",
                    label: t("状态", "Status"),
                    children: <Tag>{stateName(record.status)}</Tag>,
                  },
                  {
                    key: "host",
                    label: t("目标主机", "Target host"),
                    children: `${record.plan.machine.name} · ${record.plan.machine.id}`,
                  },
                  {
                    key: "agent",
                    label: t("Agent ID", "Agent ID"),
                    children: record.plan.machine.agent_id,
                  },
                  {key:"ssh-account",label:t("此计划的 SSH 登录账户","SSH login account frozen in this plan"),children:record.plan.ssh_account.username+" · "+record.plan.ssh_account.id},
                  {
                    key: "from",
                    label: t("原管理模式", "Previous management mode"),
                    children: modeName(record.plan.from_mode),
                  },
                  {
                    key: "target",
                    label: t("目标管理模式", "Target management mode"),
                    children: modeName(record.plan.runtime_mode),
                  },
                  {
                    key: "generation",
                    label: t("权限配置代次", "Permission generation"),
                    children: `${record.plan.previous_generation} → ${record.plan.permission_generation}`,
                  },
                  {
                    key: "release",
                    label: t("固定发行", "Pinned release"),
                    children:
                      record.plan.release?.build_id ||
                      record.plan.release?.version ||
                      record.plan.release?.artifact_sha256 ||
                      "—",
                  },
                  {
                    key: "revision",
                    label: t("审批摘要", "Approval digest"),
                    children: (
                      <Typography.Text code copyable>
                        {record.revision}
                      </Typography.Text>
                    ),
                  },
                  {
                    key: "expiry",
                    label: t("批准有效至", "Approval expires at"),
                    children: stamp(record.expires_at),
                  },
                  {
                    key: "finished",
                    label: t("结束时间", "Finished at"),
                    children: stamp(record.finished_at),
                  },
                ]}
              />
              {!!record.plan.steps?.length && (
                <ol>
                  {record.plan.steps.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ol>
              )}
              {record.plan.capabilities && (
                <Typography.Paragraph strong>
                  {t(
                    "此计划开启的任务能力：",
                    "Task capabilities enabled by this plan: ",
                  )}
                  {record.plan.capabilities.length
                    ? record.plan.capabilities
                        .map((v) => runtimeCapabilityText(v, t))
                        .join("、")
                    : t("全部关闭", "All disabled")}
                </Typography.Paragraph>
              )}
              {record.plan.warnings?.map((v, i) => (
                <Typography.Paragraph key={i} type="secondary">
                  {v}
                </Typography.Paragraph>
              ))}
              {record.error && (
                <Alert
                  className="lm-machine-form-notice"
                  showIcon
                  type="warning"
                  title={record.error}
                />
              )}
              {record.status === "awaiting_approval" &&
                !attempted.current &&
                !uncertain && (
                  <>
                    <Checkbox
                      checked={reviewed}
                      disabled={
                        busy || expired || !credentialValid || !recordVerified
                      }
                      onChange={(e) => setReviewed(e.target.checked)}
                    >
                      {t(
                        "我已审阅目标主机、管理模式、权限代次和执行步骤，仅批准此计划",
                        "I reviewed the host, management mode, permission generation, and steps and approve only this plan",
                      )}
                    </Checkbox>
                    {expired && (
                      <Alert
                        className="lm-machine-form-notice"
                        type="warning"
                        title={t(
                          "计划已过期，不可执行",
                          "Plan expired and cannot execute",
                        )}
                      />
                    )}
                    <Button
                      className="lm-machine-form-notice"
                      type="primary"
                      danger={record.plan.runtime_mode === "root"}
                      disabled={
                        !reviewed ||
                        expired ||
                        !credentialValid ||
                        !recordVerified
                      }
                      loading={busy}
                      onClick={() => void apply()}
                    >
                      {t("确认切换权限模式", "Confirm permission mode change")}
                    </Button>
                  </>
                )}
              {!credentialValid && record.status === "awaiting_approval" && (
                <Alert
                  className="lm-machine-form-notice"
                  type="warning"
                  title={t(
                    "原计划凭据已不可用，请取消后使用有效凭据重新检查",
                    "The original credential is unavailable. Cancel and check again with an active credential.",
                  )}
                />
              )}
              {record.status === "unknown" && (
                <section
                  className="lm-machine-form-notice"
                  aria-label={t(
                    "只读核对权限模式切换",
                    "Read-only permission-mode reconciliation",
                  )}
                >
                  <Typography.Paragraph>
                    {t(
                      "通过 SSH 只读查询原操作回执和 Agent 权限模式，不会重复切换。中心仍核对同次启动的回执与新鲜心跳；仅在切换成功或已验证恢复原模式后结束维护门禁。",
                      "Read the original operation receipt and Agent permission mode through SSH without replaying the switch. The center still verifies the same boot receipt and fresh heartbeat; the maintenance fence ends only after success or verified restoration of the original mode.",
                    )}
                  </Typography.Paragraph>
                  <Select
                    aria-label={t(
                      "模式切换核对 SSH 凭据",
                      "SSH credential for mode reconciliation",
                    )}
                    style={{ width: "100%" }}
                    value={reconcileCredential}
                    disabled={busy}
                    onChange={setReconcileCredential}
                    options={keys.map((v) => ({
                      value: v.id,
                      label: sshCredentialLabel(v),
                    }))}
                    placeholder={t(
                      "选择有效 root / sudo SSH 凭据",
                      "Select an active root / sudo SSH credential",
                    )}
                  />
                  {onManageAccounts&&<Button className="lm-machine-form-notice" disabled={busy} onClick={()=>{setOpen(false);onManageAccounts(result=>{setReconcileCredential(result.credential_id);setCredential(result.credential_id);setPreflight(undefined);setError("");setOpen(true)})}}>{t("管理或添加登录账户","Manage or add login accounts")}</Button>}
                  {!keys.some((v) => v.id === reconcileCredential) && (
                    <Alert
                      className="lm-machine-form-notice"
                      showIcon
                      type="warning"
                      title={t(
                        "核对凭据已过期或不可用，请选择有效凭据；没有可用项时先在主机中添加凭据",
                        "The reconciliation credential expired or is unavailable. Select an active credential, or add one to this host if none are available.",
                      )}
                    />
                  )}
                  <Button
                    className="lm-machine-form-notice"
                    loading={busy}
                    disabled={
                      !recordVerified ||
                      !keys.some((v) => v.id === reconcileCredential)
                    }
                    onClick={() => void reconcile()}
                  >
                    {t("只读核对切换结果", "Verify switch outcome read-only")}
                  </Button>
                </section>
              )}
              <Space wrap className="lm-machine-form-notice">
                {record.status === "awaiting_approval" && (
                  <Button disabled={busy} onClick={() => void cancel()}>
                    {t("取消尚未执行的计划", "Cancel unexecuted plan")}
                  </Button>
                )}
                <Button loading={busy} onClick={() => void refresh()}>
                  {t("回读原切换记录", "Read back original switch record")}
                </Button>
                {["succeeded", "failed", "cancelled"].includes(
                  record.status,
                ) && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setRecord(undefined);
                      setReviewed(false);
                      setUncertain(false);
                      preparing.current = undefined;
                      attempted.current = false;
                      setTarget(
                        status?.runtime_mode === "root" ? "user" : "root",
                      );
                    }}
                  >
                    {t("准备新的切换计划", "Prepare another switch plan")}
                  </Button>
                )}
              </Space>
            </>
          )}
          {!record && records.length > 0 && (
            <Select
              className="lm-machine-form-notice"
              aria-label={t(
                "选择权限模式变更记录",
                "Select permission mode change",
              )}
              style={{ width: "100%" }}
              placeholder={t(
                "查看已有切换记录",
                "View an existing switch record",
              )}
              options={records.map((v) => ({
                value: v.id,
                label: `${modeName(v.plan.from_mode)} → ${modeName(v.plan.runtime_mode)} · ${stateName(v.status)} · ${stamp(v.created_at)}`,
              }))}
              onChange={(id) => {
                const next = records.find((v) => v.id === id);
                if (next) {
                  keep(next);
                  attempted.current = next.status !== "awaiting_approval";
                  setCredential(next.plan.credential_id);
                  requestID.current = crypto.randomUUID();
                  setUncertain(false);
                }
              }}
            />
          )}
        </Modal>
      )}
    </section>
  );
}
