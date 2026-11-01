import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from "../shared/ui";
import { api } from "../shared/api";
import { useI18n } from "../shared/i18n";
import { errorText, type Overview, type Spec } from "./ops/model";
import "./operations.css";
import ApplicationPortFields from "./ops/ApplicationPortFields";
import ApplicationInstallDrawer from "./ops/ApplicationInstallDrawer";

export default function PrivateRegistryPage() {
  const { t } = useI18n(),
    { message } = App.useApp();
  const [data, setData] = useState<Spec>(),
    [overview, setOverview] = useState<Overview>({
      resources: [],
      agents: [],
      runs: [],
    }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [installID,setInstallID]=useState<string>();
  const registryPorts=data?.application?.spec.ports??[{name:"registry",container_port:5000},{name:"hub-cache",container_port:5001},{name:"origin-cache",container_port:5002}];
  const [dialog, setDialog] = useState<"deploy" | "external">(),
    [busy, setBusy] = useState(false),
    [switching, setSwitching] = useState(""),
    [formError, setFormError] = useState(""),
    [defaults, setDefaults] = useState<Spec>({}),
    [form] = Form.useForm();
  const clusterID = Form.useWatch("cluster_id", form),
    machineID = Form.useWatch("machine_id", form);
  const clusters = overview.resources.filter((r) => r.kind === "cluster"),
    site = data?.external?.website;
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [registry, all] = await Promise.all([
        api<Spec>("/ops/private-registry"),
        api<Overview>("/ops/overview"),
      ]);
      setData(registry);
      setOverview(all);
      if (!quiet) setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), 10000);
    return () => clearInterval(timer);
  }, [load]);
  const explain = (code: string) => {
    const messages: Record<string, [string, string]> = {
      invalid_host_ports: ["端口必须是 0～65535 的整数，并对应已声明的服务。", "Ports must be integers from 0 to 65535 for declared services."],
      duplicate_host_port: ["宿主端口不能重复；使用不同端口，或填 0 自动分配。", "Host ports must be unique. Choose different ports, or 0 for automatic allocation."],
      platform_revision_conflict: [
        "配置已更新，请刷新后重试。输入已保留。",
        "Configuration changed. Refresh and retry; your input is retained.",
      ],
      registry_data_migration_required: [
        "仓库已有固定数据位置，首版不支持直接更换机器、内网地址或对外写入集群。",
        "This registry has a fixed data location. Changing its machine, private address or publishing cluster requires migration.",
      ],
      registry_confirmation_required: [
        "请确认此地址处于受信任的隔离内网。",
        "Confirm that this address is on a trusted, isolated network.",
      ],
      registry_address_must_match_cluster_node: [
        "内网地址必须与该机器在集群中的可达 IP 一致。",
        "The private address must match this machine’s reachable IP in the cluster.",
      ],
      private_registry_install_required: [
        "请先为这个集群部署系统镜像仓库。",
        "Deploy the system registry in this cluster first.",
      ],
      platform_resource_busy: [
        "服务正在执行任务，请等待结果后重试。",
        "Wait for the current operation to finish before retrying.",
      ],
      registry_openresty_install_confirmation_required: [
        "这个集群需要网站网关，请确认安装 OpenResty。",
        "Confirm installation of OpenResty in this cluster.",
      ],
    };
    return messages[code] ? t(...messages[code]) : code;
  };
  const open = (which: "deploy" | "external", row?: Spec) => {
    setFormError("");
    setDialog(which);
    setDefaults(
      which === "deploy"
        ? {
            cluster_id: row?.cluster_id,
            machine_id: row?.machine_id,
            address: row?.address,
            host_ports:row?.host_ports??Object.fromEntries(registryPorts.map((p:Spec)=>[p.name,0])),
            cpu:
              data?.application?.spec.deployments?.find(
                (d: Spec) => d.cluster_id === row?.cluster_id,
              )?.cpu ?? 0.25,
            memory_mb:
              data?.application?.spec.deployments?.find(
                (d: Spec) => d.cluster_id === row?.cluster_id,
              )?.memory_mb ?? 256,
            cache_enabled: row?.cache_enabled ?? false,
            trusted_network_acknowledged: false,
          }
        : {
            carrier_cluster_id:
              data?.external?.carrier_cluster_id ||
              data?.deployments?.[0]?.cluster_id,
            domain: site?.spec.bindings?.[0]?.domains?.[0],
            certificate_id: site?.spec.bindings?.[0]?.certificate_id,
            username: site?.spec.auth?.users?.[0]?.username,
            password: "",
            install_openresty: false,
          },
    );
  };
  useEffect(() => {
    if (dialog) {
      form.resetFields();
      form.setFieldsValue(defaults);
    }
  }, [dialog, defaults, form]);
  const save = async () => {
    let values: Spec;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const saved=await api<Spec>(
        "/ops/private-registry/" +
          (dialog === "deploy" ? "deployments" : "external"),
        {
          method: dialog === "deploy" ? "POST" : "PUT",
          body: JSON.stringify({
            ...values,
            confirmed: true,
            revision:
              dialog === "deploy"
                ? (data?.revision ?? 0)
                : (data?.external?.revision ?? 0),
            ...(dialog === "external" && site
              ? { website_revision: site.revision }
              : {}),
          }),
        },
      );
      setDialog(undefined);
      if(dialog==="deploy")setInstallID(saved.application?.id);
      if(dialog==="deploy"&&!saved.runs?.length)void message.warning(t("配置已保存，但尚未生成新执行；请核对安装记录后重试。","Configuration saved, but no new execution was created. Inspect the history before retrying."));
      else void message.success(
        t(
          "配置已保存，部署任务已提交。",
          "Configuration saved; deployment submitted.",
        ),
      );
      await load(true);
    } catch (e) {
      setFormError(explain(errorText(e)));
      await load(true);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (row: Spec, enabled: boolean) => {
    const c = clusters.find((c) => c.id === row.cluster_id);
    if (!c) return;
    setSwitching(c.id);
    try {
      await api(
        "/ops/private-registry/clusters/" + encodeURIComponent(c.id) + "/cache",
        {
          method: "PUT",
          body: JSON.stringify({ revision: c.revision, enabled }),
        },
      );
      void message.success(
        t(
          "缓存配置已保存，正在应用。",
          "Cache configuration saved and being applied.",
        ),
      );
    } catch (e) {
      setError(explain(errorText(e)));
    } finally {
      await load(true);
      setSwitching("");
    }
  };
  const clusterName = (id: string) =>
    clusters.find((c) => c.id === id)?.name ?? id;
  const deployment = data?.deployments?.find(
      (d: Spec) => d.cluster_id === clusterID,
    ),
    cluster = clusters.find((c) => c.id === clusterID);
  const members = (overview.machines ?? []).filter((m) =>
    cluster?.spec.machine_ids.includes(m.id),
  );
  useEffect(() => {
    if (dialog !== "deploy" || !machineID) return;
    const node = cluster?.spec.nodes?.find(
      (n: Spec) => n.machine_id === machineID,
    );
    if (node) form.setFieldValue("address", node.address);
  }, [machineID, cluster, form, dialog]);
  return (
    <div className="lm-page lm-operations-page lm-registry-page">
      <div className="lm-page-heading">
        <div>
          <h1>{t("私有镜像管理", "Private images")}</h1>
        </div>
        <Space>
          <Button
            icon={<ReloadOutlined aria-hidden />}
            onClick={() => void load()}
            loading={loading}
          >
            {t("刷新", "Refresh")}
          </Button>
          {data?.application && (
            <Button
              type="primary"
              icon={<PlusOutlined aria-hidden />}
              onClick={() => open("deploy")}
            >
              {t("添加集群部署", "Add cluster deployment")}
            </Button>
          )}
        </Space>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          closable
          onClose={() => setError("")}
        />
      )}
      {loading && !data ? (
        <Spin />
      ) : !data?.application ? (
        <div className="lm-ops-install-guide lm-registry-entry">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <>
                <h3>
                  {t(
                    "请先安装 Docker Registry",
                    "Install Docker Registry first",
                  )}
                </h3>
                <p>
                  {t(
                    "选择集群和机器，建立私有仓库；内网缓存可按集群开启。",
                    "Choose a cluster and machine for your private registry. Enable the cache separately for each cluster.",
                  )}
                </p>
              </>
            }
          >
            <Button type="primary" onClick={() => open("deploy")}>
              {t("安装 Docker Registry", "Install Docker Registry")}
            </Button>
          </Empty>
        </div>
      ) : (
        <>
          <div className="lm-ops-panel lm-registry-entry">
            <div className="lm-ops-subheading">
              <div>
                <h3>{t("集群部署", "Cluster deployments")}</h3>
                <Typography.Text type="secondary">
                  sys-docker-registry
                </Typography.Text>
              </div>
            </div>
            <Table
              rowKey="cluster_id"
              pagination={false}
              dataSource={data.deployments}
              scroll={{ x: 820 }}
              columns={[
                {
                  title: t("集群 / 机器", "Cluster / machine"),
                  key: "cluster",
                  render: (_, r: Spec) => (
                    <>
                      <Link
                        to={
                          "/clusters?resource=" +
                          encodeURIComponent(r.cluster_id)
                        }
                      >
                        {clusterName(r.cluster_id)}
                      </Link>
                      <div className="lm-ops-note">
                        {overview.machines?.find((m) => m.id === r.machine_id)
                          ?.name ?? r.machine_id}
                      </div>
                    </>
                  ),
                },
                {
                  title: t("内网仓库地址", "Private registry endpoint"),
                  key: "endpoint",
                  render: (_, r: Spec) => (
                    <Typography.Text copyable={!!r.endpoint}>
                      {r.endpoint ||
                        t("等待端口分配", "Waiting for port allocation")}
                    </Typography.Text>
                  ),
                },
                {
                  title: t("内网镜像缓存", "Internal image cache"),
                  key: "cache",
                  render: (_, r: Spec) => (
                    <Switch
                      aria-label={
                        t("内网缓存 ", "Internal cache ") +
                        clusterName(r.cluster_id)
                      }
                      checked={r.cache_enabled}
                      loading={switching === r.cluster_id}
                      onChange={(v) => void toggle(r, v)}
                    />
                  ),
                },
                {
                  title: t("部署状态", "Deployment status"),
                  key: "state",
                  render: (_, r: Spec) => (
                    <Tag
                      color={
                        r.status.last_error
                          ? "error"
                          : !r.status.cache_pending &&
                              r.status.applied_revision ===
                                r.status.desired_revision &&
                              r.status.applied_revision
                            ? "success"
                            : undefined
                      }
                    >
                      {r.status.last_error
                        ? t("部署失败", "Deployment failed")
                        : !r.status.cache_pending &&
                            r.status.applied_revision ===
                              r.status.desired_revision &&
                            r.status.applied_revision
                          ? t("已应用", "Applied")
                          : t("等待应用", "Pending")}
                    </Tag>
                  ),
                },
                {
                  title: t("操作", "Actions"),
                  key: "actions",
                  render: (_, r: Spec) => (
                    <Space wrap><Button size="small" onClick={() => open("deploy", r)}>{t("配置 / 重新部署", "Configure / redeploy")}</Button><Button size="small" onClick={()=>setInstallID(data.application.id)}>{t("安装记录", "Installation history")}</Button></Space>
                  ),
                },
              ]}
            />
            <p className="lm-ops-note">
              {t(
                "缓存按需拉取，不预下载全部镜像。开启后，新部署优先通过本集群缓存拉取；已有业务容器保持运行。",
                "Images are cached on demand. New deployments prefer this cluster’s cache; existing containers keep running.",
              )}
            </p>
          </div>
          <div className="lm-ops-panel">
            <div className="lm-ops-subheading">
              <h3>{t("对外发布入口", "Publishing endpoint")}</h3>
              <Button onClick={() => open("external")}>
                {site
                  ? t("配置入口", "Configure endpoint")
                  : t("设置对外入口", "Set publishing endpoint")}
              </Button>
            </div>
            {site ? (
              <Descriptions
                column={1}
                items={[
                  {
                    key: "domain",
                    label: t("域名", "Domain"),
                    children: (
                      <Typography.Text copyable>
                        {"https://" + site.spec.bindings[0].domains[0]}
                      </Typography.Text>
                    ),
                  },
                  {
                    key: "cluster",
                    label: t("写入集群", "Publishing cluster"),
                    children: clusterName(data.external.carrier_cluster_id),
                  },
                  {
                    key: "website",
                    label: t("关联网站", "Linked website"),
                    children: (
                      <Link
                        to={"/websites?resource=" + encodeURIComponent(site.id)}
                      >
                        {site.name}
                      </Link>
                    ),
                  },
                ]}
              />
            ) : (
              <Typography.Text type="secondary">
                {t(
                  "选定一个仓库部署，配置域名、HTTPS 证书和登录账号，自动关联网站。",
                  "Choose one deployment and configure its domain, HTTPS certificate and account to create a linked website.",
                )}
              </Typography.Text>
            )}
          </div>
        </>
      )}
      <ApplicationInstallDrawer resourceId={installID} resources={overview.resources} machines={overview.machines??[]} onClose={()=>setInstallID(undefined)} onManage={()=>{setInstallID(undefined);open("deploy",data?.deployments?.[0])}}/>
      <Modal
        title={
          dialog === "deploy"
            ? t("部署系统镜像仓库", "Deploy system registry")
            : t("配置对外发布入口", "Configure publishing endpoint")
        }
        open={!!dialog}
        onCancel={() => {
          if (!busy) setDialog(undefined);
        }}
        onOk={() => void save()}
        confirmLoading={busy}
        okText={t("保存并部署", "Save and deploy")}
        cancelText={t("取消", "Cancel")}
        width={640}
        style={{top:24}}
        styles={{body:{maxHeight:'calc(100dvh - 200px)',overflowY:'auto',overscrollBehavior:'contain'}}}
        forceRender
      >
        {formError && <Alert type="error" showIcon title={formError} />}
        <Form form={form} layout="vertical">
          {dialog === "deploy" ? (
            <>
              <Form.Item
                name="cluster_id"
                label={t("部署集群", "Cluster")}
                rules={[{ required: true }]}
                extra={
                  !clusters.length && (
                    <Link to="/clusters">
                      {t("先创建集群", "Create a cluster first")}
                    </Link>
                  )
                }
              >
                <Select
                  options={clusters.map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                  onChange={(cid) => {
                    const d = data?.deployments?.find(
                      (d: Spec) => d.cluster_id === cid,
                    );
                    form.setFieldsValue({
                      machine_id: d?.machine_id,
                      address: d?.address,
                      host_ports:d?.host_ports??Object.fromEntries(registryPorts.map((p:Spec)=>[p.name,0])),
                      cache_enabled: d?.cache_enabled ?? false,
                    });
                  }}
                />
              </Form.Item>
              <Form.Item
                name="machine_id"
                label={t("部署机器", "Machine")}
                rules={[{ required: true }]}
              >
                <Select
                  disabled={!clusterID || !!deployment}
                  options={members
                    .filter((m) => m.agent_id)
                    .map((m) => ({ value: m.id, label: m.name }))}
                />
              </Form.Item>
              <Form.Item
                name="address"
                label={t("内网监听 IP", "Private listen IP")}
                rules={[{ required: true }]}
                extra={t(
                  "使用集群内可达的私有 IP；不允许公网 IP 或通配地址。",
                  "Use a private IP reachable inside the cluster. Public and wildcard addresses are rejected.",
                )}
              >
                <Input readOnly={!!deployment} />
              </Form.Item>
              <ApplicationPortFields ports={registryPorts}/>
              <Collapse items={[{key:'resources',label:t('资源限制（高级）','Resource limits (advanced)'),forceRender:true,children:<div className="lm-ops-grid">
                <Form.Item name="cpu" label={t("CPU（核）", "CPU (cores)")}>
                  <InputNumber min={0.01} max={1024} />
                </Form.Item>
                <Form.Item
                  name="memory_mb"
                  label={t("内存（MiB）", "Memory (MiB)")}
                >
                  <InputNumber min={64} max={1048576} />
                </Form.Item>
              </div>}]}/>
              <Form.Item
                name="cache_enabled"
                label={t("开启内网镜像缓存", "Enable internal image cache")}
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                name="trusted_network_acknowledged"
                valuePropName="checked"
                rules={[
                  {
                    validator: (_, v) =>
                      v
                        ? Promise.resolve()
                        : Promise.reject(
                            Error(
                              t(
                                "请确认内网访问边界",
                                "Confirm the internal network boundary",
                              ),
                            ),
                          ),
                  },
                ]}
              >
                <Checkbox>
                  {t(
                    "此地址仅在受信任内网可达；内网仓库不鉴权，网络隔离由我维护。",
                    "This address is reachable only on a trusted internal network. I maintain network isolation for the anonymous registry.",
                  )}
                </Checkbox>
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item
                name="carrier_cluster_id"
                label={t("对外写入集群", "Publishing cluster")}
                rules={[{ required: true }]}
                extra={t(
                  "镜像存储在此集群，首版配置后固定。其他集群可缓存拉取。",
                  "Images live in this cluster, which remains fixed in this version. Other clusters can cache pulls.",
                )}
              >
                <Select
                  disabled={!!data?.external?.carrier_cluster_id}
                  options={data?.deployments?.map((d: Spec) => ({
                    value: d.cluster_id,
                    label: clusterName(d.cluster_id),
                  }))}
                />
              </Form.Item>
              <Form.Item
                name="domain"
                label={t("仓库域名", "Registry domain")}
                rules={[{ required: true }]}
              >
                <Input placeholder="registry.example.com" />
              </Form.Item>
              <Form.Item
                name="certificate_id"
                label={t("HTTPS 证书", "HTTPS certificate")}
                rules={[{ required: true }]}
                extra={
                  <Link to="/certificates">
                    {t("管理证书", "Manage certificates")}
                  </Link>
                }
              >
                <Select
                  options={overview.resources
                    .filter((r) => r.kind === "certificate")
                    .map((r) => ({ value: r.id, label: r.name }))}
                />
              </Form.Item>
              <Form.Item
                name="username"
                label={t("登录账号", "Username")}
                rules={[{ required: true }]}
              >
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item
                name="password"
                label={t("登录密码", "Password")}
                rules={[{ required: !site, min: 8, max: 72 }]}
                extra={
                  site
                    ? t(
                        "留空保留同名账号的现有密码。",
                        "Leave blank to retain the password for the same username.",
                      )
                    : undefined
                }
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Form.Item name="install_openresty" valuePropName="checked">
                <Checkbox>
                  {t(
                    "如本集群未部署网站网关，同时安装 OpenResty。",
                    "Install OpenResty if this cluster has no website gateway.",
                  )}
                </Checkbox>
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}
