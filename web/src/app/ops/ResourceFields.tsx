import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Divider,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
} from "../../shared/ui";
import { useI18n } from "../../shared/i18n";
import type { Agent, Resource, ResourceKind } from "./model";

type Props = {
  kind: ResourceKind;
  resources: Resource[];
  agents: Agent[];
  existing?: Resource;
};
export function MapFields({
  name,
  label,
  keyLabel,
  valueLabel,
  code = false,
}: {
  name: (string | number)[];
  label: string;
  keyLabel: string;
  valueLabel: string;
  code?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        <div className="lm-ops-repeater">
          <div className="lm-ops-subheading">
            <span>{label}</span>
            <Button
              size="small"
              icon={<PlusOutlined aria-hidden />}
              onClick={() => add({ key: "", value: "" })}
            >
              {t("添加", "Add")}
            </Button>
          </div>
          {fields.map((field) => (
            <div
              className={"lm-ops-map-row" + (code ? " lm-ops-map-code" : "")}
              key={field.key}
            >
              <Form.Item
                name={[field.name, "key"]}
                rules={[
                  { required: true, message: t("请填写名称", "Enter a name") },
                ]}
              >
                <Input aria-label={keyLabel} placeholder={keyLabel} />
              </Form.Item>
              <Form.Item
                name={[field.name, "value"]}
                rules={[
                  { required: !code, message: t("请填写值", "Enter a value") },
                ]}
              >
                {code ? (
                  <Input.TextArea
                    rows={3}
                    aria-label={valueLabel}
                    placeholder={valueLabel}
                  />
                ) : (
                  <Input aria-label={valueLabel} placeholder={valueLabel} />
                )}
              </Form.Item>
              <Button
                type="text"
                aria-label={t("删除行", "Remove row")}
                icon={<MinusCircleOutlined aria-hidden />}
                onClick={() => remove(field.name)}
              />
            </div>
          ))}
        </div>
      )}
    </Form.List>
  );
}
function Values({
  name,
  label,
  placeholder,
}: {
  name: string;
  label: string;
  placeholder: string;
}) {
  const { t } = useI18n();
  return (
    <Form.List name={["spec", name]}>
      {(fields, { add, remove }) => (
        <div className="lm-ops-repeater">
          <div className="lm-ops-subheading">
            <span>{label}</span>
            <Button
              size="small"
              icon={<PlusOutlined aria-hidden />}
              onClick={() => add({ value: "" })}
            >
              {t("添加", "Add")}
            </Button>
          </div>
          {fields.map((f) => (
            <div key={f.key} className="lm-ops-inline-row">
              <Form.Item
                name={[f.name, "value"]}
                rules={[
                  { required: true, message: t("请填写内容", "Enter a value") },
                ]}
              >
                <Input aria-label={label} placeholder={placeholder} />
              </Form.Item>
              <Button
                type="text"
                aria-label={t("删除行", "Remove row")}
                icon={<MinusCircleOutlined aria-hidden />}
                onClick={() => remove(f.name)}
              />
            </div>
          ))}
        </div>
      )}
    </Form.List>
  );
}
export default function ResourceFields({
  kind,
  resources,
  agents,
  existing,
}: Props) {
  const { t } = useI18n(),
    form = Form.useFormInstance(),
    source = Form.useWatch(["spec", "source"], form),
    mode = Form.useWatch(["spec", "mode"], form),
    targetType = Form.useWatch(["spec", "type"], form),
    provider = Form.useWatch(["spec", "provider"], form),
    https = Form.useWatch(["spec", "https"], form),
    dnsEnabled = Form.useWatch(["spec", "dns_enabled"], form),
    healthType = Form.useWatch(["spec", "health", "type"], form),
    networkMode = Form.useWatch(["spec", "network_mode"], form);
  const required = [
    { required: true, message: t("请填写此项", "This field is required") },
  ];
  const opts = (resourceKind: ResourceKind) =>
    resources
      .filter((r) => r.kind === resourceKind)
      .map((r) => ({ value: r.id, label: r.name }));
  const agentOptions = agents.map((a) => ({
    value: a.id,
    label: a.hostname ?? a.host_id ?? a.id,
  }));
  const ref = (
    name: string,
    label: string,
    resourceKind: ResourceKind,
    needed = true,
  ) => (
    <Form.Item
      name={["spec", name]}
      label={label}
      rules={needed ? required : []}
    >
      <Select
        showSearch
        optionFilterProp="label"
        allowClear
        options={opts(resourceKind)}
        placeholder={t("选择已登记资源", "Choose a registered resource")}
      />
    </Form.Item>
  );
  const text = (
    name: string,
    label: string,
    needed = false,
    placeholder?: string,
  ) => (
    <Form.Item
      name={["spec", name]}
      label={label}
      rules={needed ? required : []}
    >
      <Input placeholder={placeholder} />
    </Form.Item>
  );
  const number = (name: string, label: string, min = 1, max = 65535) => (
    <Form.Item name={["spec", name]} label={label} rules={required}>
      <InputNumber min={min} max={max} />
    </Form.Item>
  );
  const providers = [
    { value: "aliyun", label: t("阿里云", "Alibaba Cloud") },
    { value: "tencent", label: t("腾讯云 / DNSPod", "Tencent Cloud / DNSPod") },
    { value: "volcengine", label: t("火山引擎", "Volcengine") },
  ];
  const tags = (
    name: string,
    label: string,
    needed = true,
    placeholder?: string,
  ) => (
    <Form.Item
      name={["spec", name]}
      label={label}
      rules={needed ? required : []}
    >
      <Select
        mode="tags"
        tokenSeparators={[",", " ", "\n"]}
        open={false}
        placeholder={placeholder}
      />
    </Form.Item>
  );
  const targets = (
    <Form.Item
      name={["spec", "agent_ids"]}
      label={t("目标机器", "Target machines")}
      rules={required}
    >
      <Select
        mode="multiple"
        showSearch
        optionFilterProp="label"
        options={agentOptions}
        placeholder={t(
          "选择已注册 Agent 的机器",
          "Choose machines with registered Agents",
        )}
      />
    </Form.Item>
  );
  return (
    <>
      {kind === "credential" && (
        <>
          <Form.Item
            name={["spec", "provider"]}
            label={t("云平台", "Provider")}
            rules={required}
          >
            <Select options={providers} />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title={t(
              "凭据加密保存；保存后不会回显密钥",
              "Credentials are encrypted and secrets are never displayed again",
            )}
          />
          <Form.Item
            name={["spec", "access_key_id"]}
            label="Access Key ID / SecretId"
            rules={existing?.spec.has_access_key_id ? [] : required}
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={
                existing
                  ? t("留空保留现有值", "Leave blank to retain")
                  : undefined
              }
            />
          </Form.Item>
          <Form.Item
            name={["spec", "access_key_secret"]}
            label="Access Key Secret / SecretKey"
            rules={existing?.spec.has_access_key_secret ? [] : required}
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={
                existing
                  ? t("留空保留现有值", "Leave blank to retain")
                  : undefined
              }
            />
          </Form.Item>
          <Form.Item
            name={["spec", "session_token"]}
            label={t("临时凭据 Token（可选）", "Session token (optional)")}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </>
      )}
      {kind === "dns_zone" && (
        <>
          {text("domain", t("托管域名", "Hosted domain"), true, "example.com")}
          {ref(
            "credential_id",
            t("DNS 平台凭据", "DNS credentials"),
            "credential",
          )}
          {text(
            "scope",
            t("管理范围（可选子域）", "Managed subdomain (optional)"),
            false,
            "dev.example.com",
          )}
          <Alert
            type="info"
            showIcon
            title={t(
              "支持阿里云 DNS 与 DNSPod；自动任务只修改自己管理的记录",
              "Supports Alibaba Cloud DNS and DNSPod; automation changes only its own records",
            )}
          />
        </>
      )}
      {kind === "acme_account" && (
        <>
          <Form.Item
            name={["spec", "directory_url"]}
            label={t("ACME 服务", "ACME service")}
            rules={required}
          >
            <AutoComplete
              options={[
                {
                  value: "letsencrypt-staging",
                  label: "Let's Encrypt Staging",
                },
                {
                  value: "letsencrypt-production",
                  label: "Let's Encrypt Production",
                },
              ]}
            />
          </Form.Item>
          {text(
            "email",
            t("联系邮箱", "Contact email"),
            true,
            "ops@example.com",
          )}
          <div className="lm-ops-grid">
            {text("eab_kid", t("EAB Key ID（可选）", "EAB key ID (optional)"))}
            <Form.Item
              name={["spec", "eab_hmac_key"]}
              label={t("EAB HMAC Key（可选）", "EAB HMAC key (optional)")}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </div>
          <Form.Item
            name={["spec", "terms_agreed"]}
            valuePropName="checked"
            rules={[
              {
                validator: (_, v) =>
                  v
                    ? Promise.resolve()
                    : Promise.reject(
                        Error(
                          t(
                            "注册前需同意 CA 服务条款",
                            "Agree to the CA terms before registering",
                          ),
                        ),
                      ),
              },
            ]}
          >
            <Checkbox>
              {t(
                "我已阅读并同意所选 CA 的服务条款",
                "I have read and agree to the selected CA terms",
              )}
            </Checkbox>
          </Form.Item>
        </>
      )}
      {kind === "certificate" && (
        <>
          <Form.Item
            name={["spec", "source"]}
            label={t("证书来源", "Certificate source")}
            rules={required}
          >
            <Select
              options={[
                {
                  value: "acme",
                  label: t("ACME 自动申请", "ACME automatic issuance"),
                },
                {
                  value: "uploaded",
                  label: t("上传证书", "Upload certificate"),
                },
                { value: "self_signed", label: t("自签发", "Self-signed") },
              ]}
            />
          </Form.Item>
          {tags(
            "domains",
            t("证书域名", "Certificate domains"),
            true,
            "example.com, *.example.com",
          )}
          {source === "acme" && (
            <>
              {ref(
                "acme_account_id",
                t("ACME 账号", "ACME account"),
                "acme_account",
              )}
              <Form.Item
                name={["spec", "dns_zone_ids"]}
                label={t("DNS 验证域名", "DNS validation zones")}
                rules={required}
              >
                <Select mode="multiple" options={opts("dns_zone")} />
              </Form.Item>
            </>
          )}
          {source === "uploaded" && (
            <>
              <Form.Item
                name={["spec", "certificate_pem"]}
                label={t("证书链 PEM", "Certificate chain PEM")}
                rules={existing?.spec.has_certificate ? [] : required}
              >
                <Input.TextArea
                  rows={5}
                  placeholder={
                    existing
                      ? t(
                          "留空保留已有证书",
                          "Leave blank to retain certificate",
                        )
                      : "-----BEGIN CERTIFICATE-----"
                  }
                  autoComplete="off"
                />
              </Form.Item>
              <Form.Item
                name={["spec", "private_key_pem"]}
                label={t("私钥 PEM", "Private key PEM")}
                rules={existing?.spec.has_private_key ? [] : required}
              >
                <Input.TextArea
                  rows={5}
                  placeholder={
                    existing
                      ? t(
                          "留空保留已有私钥",
                          "Leave blank to retain private key",
                        )
                      : "-----BEGIN PRIVATE KEY-----"
                  }
                  autoComplete="off"
                />
              </Form.Item>
              <Alert
                type="info"
                showIcon
                title={t(
                  "保存后执行“导入证书版本”，开启到期提醒并分发到启用的目标",
                  "After saving, run ‘Import certificate version’ for expiry reminders and delivery to enabled targets",
                )}
              />
            </>
          )}
          {source === "self_signed" &&
            number("validity_days", t("有效天数", "Validity in days"), 1, 825)}
          {source !== "uploaded" && (
            <>
              <div className="lm-ops-grid">
                <Form.Item
                  name={["spec", "auto_renew"]}
                  label={t(
                    "授权自动续期与重新签发",
                    "Authorize automatic renewal",
                  )}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                {number(
                  "renew_before_days",
                  t("提前续期天数", "Renew before expiry (days)"),
                  1,
                  90,
                )}
              </div>
              <p className="lm-ops-note">
                {t(
                  "启用后，平台会按策略自动签发，并将新版本分发到已启用的目标。",
                  "When enabled, the platform renews certificates and delivers new versions to enabled targets.",
                )}
              </p>
            </>
          )}
        </>
      )}
      {kind === "certificate_target" && (
        <>
          {ref("certificate_id", t("证书", "Certificate"), "certificate")}
          <Form.Item
            name={["spec", "type"]}
            label={t("目标类型", "Target type")}
            rules={required}
          >
            <Select
              options={[
                {
                  value: "directory",
                  label: t("机器目录", "Machine directory"),
                },
                { value: "cloud", label: t("云 CDN 域名", "Cloud CDN domain") },
                { value: "hook", label: t("更新后脚本", "Post-update script") },
              ]}
            />
          </Form.Item>
          {targetType === "cloud" ? (
            <>
              <div className="lm-ops-grid">
                <Form.Item
                  name={["spec", "provider"]}
                  label={t("云平台", "Cloud provider")}
                  rules={required}
                >
                  <Select options={providers} />
                </Form.Item>
                <Form.Item
                  name={["spec", "product"]}
                  label={t("服务", "Service")}
                  rules={required}
                >
                  <Select options={[{ value: "cdn", label: "CDN" }]} />
                </Form.Item>
              </div>
              <Form.Item
                name={["spec", "credential_id"]}
                label={t("对应平台凭据", "Matching cloud credentials")}
                rules={required}
              >
                <Select
                  options={resources
                    .filter(
                      (r) =>
                        r.kind === "credential" && r.spec.provider === provider,
                    )
                    .map((r) => ({ value: r.id, label: r.name }))}
                />
              </Form.Item>
              {tags(
                "domains",
                t("CDN 加速域名", "CDN accelerated domains"),
                true,
                "cdn.example.com",
              )}
            </>
          ) : (
            <>
              <Form.Item
                name={["spec", "agent_id"]}
                label={t("执行机器", "Execution machine")}
                rules={required}
              >
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={agentOptions}
                />
              </Form.Item>
              {targetType === "directory" ? (
                <>
                  {text(
                    "path",
                    t(
                      "安装目录（绝对路径）",
                      "Installation directory (absolute path)",
                    ),
                    true,
                    "/etc/ssl/example",
                  )}
                  <div className="lm-ops-grid">
                    {text(
                      "certificate_file",
                      t("证书文件名", "Certificate filename"),
                      true,
                    )}
                    {text(
                      "private_key_file",
                      t("私钥文件名", "Private key filename"),
                      true,
                    )}
                    {text("mode", t("证书权限", "Certificate mode"), true)}
                    {text(
                      "private_key_mode",
                      t("私钥权限", "Private key mode"),
                      true,
                    )}
                    {text("owner", t("文件所有者（可选）", "Owner (optional)"))}
                    {text("group", t("文件所属组（可选）", "Group (optional)"))}
                  </div>
                </>
              ) : (
                <>
                  <div className="lm-ops-grid">
                    <Form.Item
                      name={["spec", "interpreter"]}
                      label={t("解释器", "Interpreter")}
                      rules={required}
                    >
                      <Select
                        options={[
                          "/bin/sh",
                          "/bin/bash",
                          "/usr/bin/python3",
                        ].map((value) => ({ value, label: value }))}
                      />
                    </Form.Item>
                    {number(
                      "timeout_ms",
                      t("超时（毫秒）", "Timeout (milliseconds)"),
                      1000,
                      300000,
                    )}
                  </div>
                  <Form.Item
                    name={["spec", "script"]}
                    label={t("脚本正文", "Script body")}
                    rules={existing?.spec.has_script ? [] : required}
                    extra={t(
                      "脚本以所选 Agent 的系统权限运行；环境只包含显式设置的值与证书上下文。",
                      "Runs with the selected Agent’s system permissions, using only explicit environment values and certificate context.",
                    )}
                  >
                    <Input.TextArea
                      rows={9}
                      className="lm-ops-code"
                      autoComplete="off"
                      placeholder={
                        existing?.spec.has_script
                          ? t(
                              "留空保留已有脚本",
                              "Leave blank to retain script",
                            )
                          : "#!/bin/sh\nset -eu\n"
                      }
                    />
                  </Form.Item>
                  <MapFields
                    name={["spec", "env_rows"]}
                    label={t("显式环境变量", "Explicit environment")}
                    keyLabel={t("变量名", "Variable name")}
                    valueLabel={t("变量值", "Variable value")}
                  />
                  {existing?.spec.has_env && (
                    <>
                      <p className="lm-ops-note">
                        {t(
                          "已有变量（值不回显）",
                          "Existing variables (values hidden)",
                        )}
                        : {(existing.spec.env_keys ?? []).join(", ")} ·{" "}
                        {t(
                          "留空保留；填写完整新列表以替换。",
                          "Leave blank to retain; enter a complete list to replace.",
                        )}
                      </p>
                      <Form.Item
                        name={["spec", "clear_env"]}
                        valuePropName="checked"
                      >
                        <Checkbox>
                          {t(
                            "清空已有环境变量",
                            "Clear existing environment variables",
                          )}
                        </Checkbox>
                      </Form.Item>
                    </>
                  )}
                  <Alert
                    type="info"
                    showIcon
                    title={t(
                      "每个证书版本触发一次；未知结果需人工核对后重试",
                      "Runs once per certificate version; inspect unknown results before retrying",
                    )}
                  />
                </>
              )}
            </>
          )}
          <Form.Item
            name={["spec", "enabled"]}
            label={t(
              "证书更新后自动执行",
              "Run automatically after certificate updates",
            )}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <p className="lm-ops-note">
            {t(
              "启用即授权此目标按保存的参数持续执行。修改配置后需要重新保存授权。",
              "Enabling authorizes continued execution with these parameters. Save again to authorize changes.",
            )}
          </p>
        </>
      )}
      {kind === "application" && (
        <>
          <Form.Item
            name={["spec", "mode"]}
            label={t("部署方式", "Deployment mode")}
            rules={required}
          >
            <Select
              options={[
                { value: "container", label: t("单容器", "Single container") },
                { value: "compose", label: "Docker Compose" },
              ]}
            />
          </Form.Item>
          {targets}
          {mode === "compose" ? (
            <Form.Item
              name={["spec", "compose"]}
              label={t("Compose 配置（YAML）", "Compose configuration (YAML)")}
              rules={required}
            >
              <Input.TextArea
                rows={12}
                className="lm-ops-code"
                placeholder={
                  'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8080:80"'
                }
              />
            </Form.Item>
          ) : (
            <>
              {text(
                "image",
                t("容器镜像", "Container image"),
                true,
                "nginx:alpine",
              )}
              <div className="lm-ops-grid">
                <Form.Item
                  name={["spec", "restart"]}
                  label={t("重启策略", "Restart policy")}
                >
                  <Select
                    allowClear
                    placeholder="unless-stopped"
                    options={[
                      "no",
                      "on-failure",
                      "always",
                      "unless-stopped",
                    ].map((value) => ({ value, label: value }))}
                  />
                </Form.Item>
                {text(
                  "working_dir",
                  t("工作目录（可选）", "Working directory (optional)"),
                )}
                {text("user", t("运行用户（可选）", "Runtime user (optional)"))}
                <Form.Item
                  name={["spec", "read_only"]}
                  label={t("只读根文件系统", "Read-only root filesystem")}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
              </div>
              <Values
                name="command_rows"
                label={t(
                  "启动命令参数（按顺序）",
                  "Command arguments (in order)",
                )}
                placeholder="nginx"
              />
              <MapFields
                name={["spec", "env_rows"]}
                label={t("环境变量", "Environment variables")}
                keyLabel={t("变量名", "Variable name")}
                valueLabel={t("变量值", "Variable value")}
              />
              <div className="lm-ops-grid">
                <Form.Item
                  name={["spec", "network_mode"]}
                  label={t("网络模式", "Network mode")}
                  rules={required}
                >
                  <Select
                    options={["bridge", "host", "none"].map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                </Form.Item>
                {networkMode === "bridge" &&
                  tags(
                    "networks",
                    t("加入 Docker 网络", "Docker networks"),
                    false,
                    "app-network",
                  )}
              </div>
              {networkMode !== "host" ? (
                <Form.List name={["spec", "ports"]}>
                  {(fields, { add, remove }) => (
                    <div className="lm-ops-repeater">
                      <div className="lm-ops-subheading">
                        <span>{t("发布端口", "Published ports")}</span>
                        <Button
                          size="small"
                          aria-label={t("添加端口", "Add port")}
                          icon={<PlusOutlined aria-hidden />}
                          onClick={() => add({ protocol: "tcp" })}
                        >
                          {t("添加端口", "Add port")}
                        </Button>
                      </div>
                      {fields.map((f) => (
                        <div key={f.key} className="lm-ops-port-row">
                          <Form.Item name={[f.name, "host_ip"]}>
                            <Input
                              placeholder={t(
                                "宿主 IP（可选）",
                                "Host IP (optional)",
                              )}
                              aria-label={t("宿主 IP", "Host IP")}
                            />
                          </Form.Item>
                          <Form.Item
                            name={[f.name, "host_port"]}
                            rules={required}
                          >
                            <InputNumber
                              min={1}
                              max={65535}
                              placeholder={t("宿主端口", "Host port")}
                              aria-label={t("宿主端口", "Host port")}
                            />
                          </Form.Item>
                          <span>→</span>
                          <Form.Item
                            name={[f.name, "container_port"]}
                            rules={required}
                          >
                            <InputNumber
                              min={1}
                              max={65535}
                              placeholder={t("容器端口", "Container port")}
                              aria-label={t("容器端口", "Container port")}
                            />
                          </Form.Item>
                          <Form.Item name={[f.name, "protocol"]}>
                            <Select
                              options={[
                                { value: "tcp", label: "TCP" },
                                { value: "udp", label: "UDP" },
                              ]}
                            />
                          </Form.Item>
                          <Button
                            type="text"
                            aria-label={t("删除端口", "Remove port")}
                            icon={<MinusCircleOutlined aria-hidden />}
                            onClick={() => remove(f.name)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </Form.List>
              ) : (
                <Alert
                  type="info"
                  showIcon
                  title={t(
                    "host 网络直接使用宿主端口",
                    "Host networking uses host ports directly",
                  )}
                />
              )}
            </>
          )}
          <Form.List name={["spec", "mounts"]}>
            {(fields, { add, remove }) => (
              <div className="lm-ops-repeater">
                <div className="lm-ops-subheading">
                  <span>{t("目录与托管文件", "Mounts and managed files")}</span>
                  <Button
                    size="small"
                    icon={<PlusOutlined aria-hidden />}
                    onClick={() =>
                      add({ type: "config", read_only: true, file_rows: [] })
                    }
                  >
                    {t("添加挂载", "Add mount")}
                  </Button>
                </div>
                {fields.map((f) => (
                  <div key={f.key} className="lm-ops-mount">
                    <div className="lm-ops-subheading">
                      <strong>
                        {t("挂载", "Mount")} {f.name + 1}
                      </strong>
                      <Button
                        type="text"
                        aria-label={t("删除挂载", "Remove mount")}
                        icon={<MinusCircleOutlined aria-hidden />}
                        onClick={() => remove(f.name)}
                      />
                    </div>
                    <div className="lm-ops-grid">
                      <Form.Item
                        name={[f.name, "type"]}
                        label={t("挂载类型", "Mount type")}
                        rules={required}
                      >
                        <Select
                          options={[
                            {
                              value: "config",
                              label: t(
                                "版本化配置文件",
                                "Versioned configuration",
                              ),
                            },
                            {
                              value: "init",
                              label: t(
                                "首次初始化文件",
                                "Initialization files",
                              ),
                            },
                            {
                              value: "data",
                              label: t("宿主数据目录", "Host data directory"),
                            },
                            { value: "volume", label: "Docker volume" },
                          ]}
                        />
                      </Form.Item>
                      <Form.Item
                        name={[f.name, "target"]}
                        label={t("容器内绝对路径", "Container absolute path")}
                        rules={required}
                      >
                        <Input placeholder="/etc/nginx/conf.d" />
                      </Form.Item>
                      {mode === "compose" && (
                        <Form.Item
                          name={[f.name, "service"]}
                          label={t("Compose 服务名", "Compose service name")}
                          rules={required}
                        >
                          <Input placeholder="web" />
                        </Form.Item>
                      )}
                      <Form.Item
                        name={[f.name, "source"]}
                        label={t(
                          "源路径或卷名（数据挂载必填）",
                          "Source path or volume (required for data)",
                        )}
                      >
                        <Input placeholder="/srv/app-data" />
                      </Form.Item>
                      <Form.Item
                        name={[f.name, "read_only"]}
                        label={t("只读挂载", "Read-only mount")}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                    </div>
                    <MapFields
                      name={[f.name, "file_rows"]}
                      label={t(
                        "托管文件（配置 / 初始化）",
                        "Managed files (configuration / initialization)",
                      )}
                      keyLabel={t("相对文件路径", "Relative file path")}
                      valueLabel={t("文件内容", "File content")}
                      code
                    />
                  </div>
                ))}
              </div>
            )}
          </Form.List>
          <div className="lm-ops-grid">
            {number("cpu", t("CPU 核数", "CPU cores"), 0.01, 1024)}
            {number("memory_mb", t("内存（MiB）", "Memory (MiB)"), 16, 1048576)}
          </div>
          <Alert
            type="info"
            showIcon
            title={t(
              "保存生成配置版本；部署需单独确认。初始化文件仅首次写入，数据目录保留运行期内容。",
              "Saving creates a revision; deployment requires confirmation. Initialization runs once and data mounts preserve runtime contents.",
            )}
          />
        </>
      )}
      {kind === "service" && (
        <>
          <div className="lm-ops-grid">
            <Form.Item
              name={["spec", "application_id"]}
              label={t("应用", "Application")}
              rules={required}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={resources
                  .filter(
                    (r) =>
                      r.kind === "application" &&
                      r.spec.mode === "container" &&
                      r.spec.network_mode !== "host",
                  )
                  .map((r) => ({ value: r.id, label: r.name }))}
              />
            </Form.Item>
            {ref(
              "node_pool_id",
              t("目标机器池", "Target node pool"),
              "node_pool",
            )}
            {number("replicas", t("副本数", "Replicas"), 0, 100)}
            {number(
              "container_port",
              t("容器服务端口", "Container service port"),
            )}
            {number(
              "cpu",
              t("每副本 CPU 核数", "CPU cores per replica"),
              0.01,
              1024,
            )}
            {number(
              "memory_mb",
              t("每副本内存（MiB）", "Memory per replica (MiB)"),
              16,
              1048576,
            )}
          </div>
          <Divider titlePlacement="start">
            {t("健康与数据约束", "Health and data constraints")}
          </Divider>
          <div className="lm-ops-grid">
            <Form.Item
              name={["spec", "health", "type"]}
              label={t("探活方式", "Health check")}
            >
              <Select
                options={[
                  { value: "tcp", label: "TCP" },
                  { value: "http", label: "HTTP" },
                ]}
              />
            </Form.Item>
            <Form.Item
              name={["spec", "health", "interval_seconds"]}
              label={t("探活间隔（秒）", "Health interval (seconds)")}
            >
              <InputNumber min={1} max={3600} />
            </Form.Item>
          </div>
          {healthType === "http" && (
            <Form.Item
              name={["spec", "health", "path"]}
              label={t("健康检查路径", "Health path")}
              rules={required}
            >
              <Input placeholder="/health" />
            </Form.Item>
          )}
          <Form.Item
            name={["spec", "stateful"]}
            label={t("有状态 / 本地业务数据", "Stateful / local business data")}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title={t(
              "平台在机器池内分配资源与端口；只有就绪实例进入服务发现",
              "The platform reserves node resources and ports; only ready instances enter discovery",
            )}
            description={t(
              "有状态实例绑定数据所在机器。Agent 失联时保留资源，需确认原实例状态后再恢复。",
              "Stateful instances stay with their data. Agent disconnection preserves reservations until the original instance is checked.",
            )}
          />
        </>
      )}
      {kind === "node_pool" && (
        <>
          {targets}
          <div className="lm-ops-grid">
            {number(
              "port_start",
              t("托管端口起始值", "Managed port range start"),
            )}
            {number("port_end", t("托管端口结束值", "Managed port range end"))}
          </div>
          <Form.List name={["spec", "nodes"]}>
            {(fields, { add, remove }) => (
              <div className="lm-ops-repeater">
                <div className="lm-ops-subheading">
                  <span>
                    {t("机器地址与资源容量", "Node addresses and capacity")}
                  </span>
                  <Button
                    size="small"
                    icon={<PlusOutlined aria-hidden />}
                    onClick={() => add({ cpu: 2, memory_mb: 2048 })}
                  >
                    {t("添加机器容量", "Add node capacity")}
                  </Button>
                </div>
                {fields.map((f) => (
                  <div className="lm-ops-mount" key={f.key}>
                    <div className="lm-ops-grid">
                      <Form.Item
                        name={[f.name, "agent_id"]}
                        label={t("机器", "Machine")}
                        rules={required}
                      >
                        <Select options={agentOptions} />
                      </Form.Item>
                      <Form.Item
                        name={[f.name, "address"]}
                        label={t("机器可达 IP", "Reachable IP")}
                        rules={required}
                      >
                        <Input placeholder="10.0.0.11" />
                      </Form.Item>
                      <Form.Item
                        name={[f.name, "public_address"]}
                        label={t("公网 IP（可选）", "Public IP (optional)")}
                      >
                        <Input />
                      </Form.Item>
                      <Form.Item
                        name={[f.name, "cpu"]}
                        label={t("可分配 CPU", "Allocatable CPU")}
                        rules={required}
                      >
                        <InputNumber min={0.1} />
                      </Form.Item>
                      <Form.Item
                        name={[f.name, "memory_mb"]}
                        label={t(
                          "可分配内存（MiB）",
                          "Allocatable memory (MiB)",
                        )}
                        rules={required}
                      >
                        <InputNumber min={16} />
                      </Form.Item>
                    </div>
                    <Button size="small" danger onClick={() => remove(f.name)}>
                      {t("删除机器配置", "Remove node settings")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Form.List>
        </>
      )}
      {kind === "gateway_group" && (
        <>
          {targets}
          {text("image", t("OpenResty 镜像", "OpenResty image"), true)}
          <div className="lm-ops-grid">
            {number("http_port", t("HTTP 监听端口", "HTTP listener port"))}
            {number("https_port", t("HTTPS 监听端口", "HTTPS listener port"))}
          </div>
          <Form.List name={["spec", "public_address_rows"]}>
            {(fields, { add, remove }) => (
              <div className="lm-ops-repeater">
                <div className="lm-ops-subheading">
                  <span>
                    {t(
                      "机器公网地址（DNS 使用）",
                      "Node public addresses (for DNS)",
                    )}
                  </span>
                  <Button
                    size="small"
                    icon={<PlusOutlined aria-hidden />}
                    onClick={() => add({})}
                  >
                    {t("添加地址", "Add address")}
                  </Button>
                </div>
                {fields.map((f) => (
                  <div className="lm-ops-map-row" key={f.key}>
                    <Form.Item name={[f.name, "key"]} rules={required}>
                      <Select
                        aria-label={t("网关机器", "Gateway machine")}
                        options={agentOptions}
                        placeholder={t("选择机器", "Choose a machine")}
                      />
                    </Form.Item>
                    <Form.Item name={[f.name, "value"]} rules={required}>
                      <Input
                        aria-label={t("公网 IP", "Public IP")}
                        placeholder="203.0.113.10"
                      />
                    </Form.Item>
                    <Button
                      type="text"
                      icon={<MinusCircleOutlined aria-hidden />}
                      aria-label={t("删除地址", "Remove address")}
                      onClick={() => remove(f.name)}
                    />
                  </div>
                ))}
              </div>
            )}
          </Form.List>
          <Alert
            type="info"
            showIcon
            title={t(
              "OpenResty 使用 host 网络；网站同步到组内全部机器",
              "OpenResty uses host networking; websites synchronize to every node in the group",
            )}
          />
        </>
      )}
      {kind === "website" && (
        <>
          {tags(
            "domains",
            t("网站域名", "Website domains"),
            true,
            "www.example.com",
          )}
          {ref(
            "gateway_group_id",
            t("OpenResty 网关组", "OpenResty gateway group"),
            "gateway_group",
          )}
          <Form.Item
            name={["spec", "mode"]}
            label={t("网站类型", "Website type")}
            rules={required}
          >
            <Select
              options={[
                { value: "static", label: t("静态网站", "Static website") },
                { value: "proxy", label: t("反向代理", "Reverse proxy") },
                { value: "service", label: t("托管服务", "Hosted service") },
              ]}
            />
          </Form.Item>
          {mode === "static" && (
            <MapFields
              name={["spec", "file_rows"]}
              label={t("静态文件", "Static files")}
              keyLabel={t("相对文件路径", "Relative file path")}
              valueLabel={t("文件内容", "File content")}
              code
            />
          )}
          {mode === "proxy" && (
            <Values
              name="upstream_rows"
              label={t("后端地址", "Backend addresses")}
              placeholder="http://10.0.0.11:8080"
            />
          )}
          {mode === "service" &&
            ref("service_id", t("托管服务", "Hosted service"), "service")}
          <Divider titlePlacement="start">
            {t("HTTPS 与域名联动", "HTTPS and DNS integration")}
          </Divider>
          <div className="lm-ops-grid">
            <Form.Item
              name={["spec", "https"]}
              label={t("启用 HTTPS", "Enable HTTPS")}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            {https &&
              ref(
                "certificate_id",
                t("使用证书", "Certificate"),
                "certificate",
              )}
            <Form.Item
              name={["spec", "dns_enabled"]}
              label={t("自动维护域名解析", "Manage DNS records automatically")}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            {dnsEnabled &&
              ref("dns_zone_id", t("托管域名", "DNS zone"), "dns_zone")}
          </div>
          <Alert
            type="info"
            showIcon
            title={t(
              "部署先验证网关，再更新受管 DNS；服务变化自动刷新代理后端",
              "Deployment verifies gateways before updating managed DNS; service changes refresh proxy backends",
            )}
          />
        </>
      )}
    </>
  );
}
