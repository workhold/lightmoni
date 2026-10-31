import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
} from "../../shared/ui";
import { useI18n } from "../../shared/i18n";
import type { Resource } from "./model";
import ClusterUpstreams from "./ClusterUpstreams";

type Path = (string | number)[];
export default function NginxFields({
  resources, clusterIds: boundClusterIds,
  mode, locationsPath = ["spec", "locations"], watchPath = ["spec", "locations"], showSiteOptions = true, showRoutes = true,
}: {
  resources: Resource[];
  clusterIds?: string[];
  mode: string;
  locationsPath?: Path;
  watchPath?: Path;
  showSiteOptions?: boolean;
  showRoutes?: boolean;
}) {
  const { t } = useI18n();
  const form = Form.useFormInstance();
  const routing=Form.useWatch(['spec','routing_mode'],form);
  const available: string[] = Form.useWatch(["spec","cluster_ids"],form) ?? [];
  const clusterIds = boundClusterIds ?? available;
  const input = (name: Path, zh: string, en: string, placeholder?: string) => (
    <Form.Item name={name} label={t(zh, en)}>
      <Input placeholder={placeholder} />
    </Form.Item>
  );
  const number = (name: Path, zh: string, en: string, min = 0, max = 86400) => (
    <Form.Item name={name} label={t(zh, en)}>
      <InputNumber min={min} max={max} />
    </Form.Item>
  );
  const toggle = (name: Path, zh: string, en: string) => (
    <Form.Item name={name} label={t(zh, en)} valuePropName="checked">
      <Switch />
    </Form.Item>
  );
  const select = (
    name: Path,
    zh: string,
    en: string,
    options: [string, string, string][],
  ) => (
    <Form.Item name={name} label={t(zh, en)}>
      <Select
        options={options.map(([value, zh, en]) => ({
          value,
          label: t(zh, en),
        }))}
      />
    </Form.Item>
  );
  const tags = (name: Path, zh: string, en: string) => (
    <Form.Item name={name} label={t(zh, en)}>
      <Select mode="tags" tokenSeparators={[",", " "]} />
    </Form.Item>
  );
  const text = (name: Path, zh: string, en: string, placeholder?: string) => (
    <Form.Item name={name} label={t(zh, en)}>
      <Input.TextArea rows={3} spellCheck={false} placeholder={placeholder} />
    </Form.Item>
  );
  const p = ["spec", "nginx"];
  return (
    <>
      {showRoutes && <Form.List name={locationsPath}>
        {(fields, { add, remove, move }) => (
          <div className="lm-ops-repeater">
            <div className="lm-ops-subheading">
              <strong>
                {t("路径规则（Location）", "Path rules (locations)")}
              </strong>
              <Button
                icon={<PlusOutlined aria-hidden />}
                onClick={() =>
                  add({
                    path: "/",
                    match: "prefix",
                    action: "proxy",
                    cluster_targets: clusterIds.map(cluster_id=>({cluster_id,target:"proxy",upstreams:[{url:"",weight:1}]})),
                    uri_mode: "preserve",
                    websocket: true,
                    buffering: true,
                    request_buffering: true,
                    host_header: "$host",
                    connect_timeout_seconds: 5,
                    read_timeout_seconds: 60,
                    send_timeout_seconds: 60,
                    balance: "round_robin",
                    keepalive: 32,
                  })
                }
              >
                {t("添加路径规则", "Add path rule")}
              </Button>
            </div>
            <Alert
              type="info"
              showIcon
              title={t(
                "精确匹配优先；前缀取最长；正则按规则顺序。去掉或替换前缀时请用 /api/ 这类以斜杠结尾的路径。未匹配路径返回404，可配置 / 兜底。",
                "Exact matches win; prefixes use the longest match; regex rules retain their order. URI replacement requires a trailing slash, such as /api/. Add / for a fallback; otherwise unmatched paths return 404.",
              )}
            />
            {fields.map((f, index) => (
              <div key={f.key} className="lm-ops-mount">
                <div className="lm-ops-subheading">
                  <strong>
                    {t("路径规则", "Path rule")} {index + 1}
                  </strong>
                  <div>
                    <Button
                      size="small"
                      disabled={index === 0}
                      onClick={() => move(index, index - 1)}
                    >
                      {t("上移规则", "Move rule up")}
                    </Button>
                    <Button
                      size="small"
                      disabled={index === fields.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      {t("下移规则", "Move rule down")}
                    </Button>
                  </div>
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined aria-hidden />}
                    onClick={() => remove(f.name)}
                  >
                    {t("删除规则", "Remove rule")}
                  </Button>
                </div>
                <div className="lm-ops-grid">
                  {input(
                    [f.name, "path"],
                    "匹配路径 / 正则",
                    "Path / regex",
                    "/api/",
                  )}
                  {select([f.name, "match"], "匹配方式", "Match type", [
                    ["prefix", "前缀匹配", "Prefix"],
                    ["prefer_prefix", "优先前缀（^~）", "Prefer prefix (^~)"],
                    ["exact", "精确匹配（=）", "Exact (=)"],
                    ["regex", "正则匹配（~）", "Regex (~)"],
                    [
                      "regex_ci",
                      "正则不区分大小写（~*）",
                      "Case-insensitive regex (~*)",
                    ],
                  ])}
                  {select([f.name, "action"], "处理方式", "Action", [
                    ["proxy", "反向代理", "Proxy"],
                    ["return", "返回 / 重定向", "Return / redirect"],
                  ])}
                </div>
                <Form.Item
                  noStyle
                  shouldUpdate={(a, b) =>
                    JSON.stringify(watchPath.reduce((v: any,k)=>v?.[k],a)?.[f.name]) !==
                    JSON.stringify(watchPath.reduce((v: any,k)=>v?.[k],b)?.[f.name])
                  }
                >
                  {({ getFieldValue }) => {
                    const route =
                      getFieldValue([...watchPath, f.name]) ?? {};
                    return route.action === "return" ? (
                      <div className="lm-ops-grid">
                        {number(
                          [f.name, "return_status"],
                          "HTTP返回码",
                          "HTTP status",
                          200,
                          599,
                        )}
                        {input(
                          [f.name, "return_value"],
                          "响应正文 / 跳转地址",
                          "Response / redirect URL",
                          "https://$host$request_uri",
                        )}
                      </div>
                    ) : (
                      <>
                        {routing==='managed'?<Alert type="info" showIcon title={t("使用所选托管服务，在各集群发现健康后端","Uses the selected managed service and healthy backends in each cluster")}/>:<ClusterUpstreams resources={resources} routeIndex={f.name} watchPath={watchPath}/>}
                        <Collapse
                          size="small"
                          items={[
                            {
                              key: "routing",
                              label: t(
                                "转发与负载均衡",
                                "Forwarding and load balancing",
                              ),
                              children: (
                                <div className="lm-ops-grid">
                                  {select(
                                    [f.name, "balance"],
                                    "负载策略",
                                    "Load balancing",
                                    [
                                      [
                                        "round_robin",
                                        "加权轮询",
                                        "Weighted round robin",
                                      ],
                                      [
                                        "least_conn",
                                        "最少连接",
                                        "Least connections",
                                      ],
                                      ["ip_hash", "IP哈希", "IP hash"],
                                    ],
                                  )}
                                  {select(
                                    [f.name, "uri_mode"],
                                    "URI处理",
                                    "URI handling",
                                    [
                                      [
                                        "preserve",
                                        "保留原始URI",
                                        "Preserve URI",
                                      ],
                                      [
                                        "strip_prefix",
                                        "去掉匹配前缀",
                                        "Strip matching prefix",
                                      ],
                                      [
                                        "replace_prefix",
                                        "替换匹配前缀",
                                        "Replace matching prefix",
                                      ],
                                    ],
                                  )}
                                  {input(
                                    [f.name, "uri_prefix"],
                                    "替换为URI前缀",
                                    "Replacement URI prefix",
                                    "/v2/",
                                  )}
                                  {input(
                                    [f.name, "host_header"],
                                    "上游Host",
                                    "Upstream Host",
                                    "$host",
                                  )}
                                  {number(
                                    [f.name, "keepalive"],
                                    "上游空闲连接数",
                                    "Upstream keepalive connections",
                                  )}
                                  {number(
                                    [f.name, "retry_tries"],
                                    "重试次数（0为默认）",
                                    "Retry tries (0 uses default)",
                                  )}
                                  {input(
                                    [f.name, "ssl_name"],
                                    "上游TLS SNI名称",
                                    "Upstream TLS SNI name",
                                  )}
                                  {toggle(
                                    [f.name, "ssl_verify"],
                                    "校验上游TLS证书",
                                    "Verify upstream TLS",
                                  )}
                                  {select(
                                    [f.name, "proxy_redirect"],
                                    "上游重定向改写",
                                    "Upstream redirect rewriting",
                                    [
                                      ["default", "默认改写", "Default"],
                                      ["off", "关闭改写", "Off"],
                                    ],
                                  )}
                                </div>
                              ),
                            },
                            {
                              key: "transport",
                              label: t(
                                "WebSocket、超时与缓冲",
                                "WebSocket, timeouts and buffering",
                              ),
                              children: (
                                <div className="lm-ops-grid">
                                  {toggle(
                                    [f.name, "websocket"],
                                    "WebSocket升级",
                                    "WebSocket upgrade",
                                  )}
                                  {toggle(
                                    [f.name, "buffering"],
                                    "响应缓冲",
                                    "Response buffering",
                                  )}
                                  {toggle(
                                    [f.name, "request_buffering"],
                                    "请求体缓冲",
                                    "Request buffering",
                                  )}
                                  {number(
                                    [f.name, "connect_timeout_seconds"],
                                    "连接超时（秒）",
                                    "Connect timeout (s)",
                                  )}
                                  {number(
                                    [f.name, "read_timeout_seconds"],
                                    "读取超时（秒）",
                                    "Read timeout (s)",
                                  )}
                                  {number(
                                    [f.name, "send_timeout_seconds"],
                                    "发送超时（秒）",
                                    "Send timeout (s)",
                                  )}
                                  {number(
                                    [f.name, "limit_rate_kbps"],
                                    "响应限速（KiB/s，0不限）",
                                    "Response rate (KiB/s, 0 unlimited)",
                                    0,
                                    1048576,
                                  )}
                                </div>
                              ),
                            },
                            {
                              key: "cache",
                              label: t(
                                "缓存、请求速率与连接限制",
                                "Cache, request rates and connection limits",
                              ),
                              children: (
                                <>
                                  <Alert
                                    type="info"
                                    title={t(
                                      "缓存自动跳过携带Authorization、Cookie及WebSocket升级的请求；启用缓存需要响应缓冲。",
                                      "Cache bypasses Authorization, Cookie and WebSocket upgrade requests. Response buffering must be enabled.",
                                    )}
                                  />
                                  <div className="lm-ops-grid">
                                    {toggle(
                                      [f.name, "cache", "enabled"],
                                      "启用反代缓存",
                                      "Enable proxy cache",
                                    )}
                                    {number(
                                      [f.name, "cache", "ttl_seconds"],
                                      "缓存有效期（秒）",
                                      "Cache TTL (s)",
                                      1,
                                      31536000,
                                    )}
                                    {number(
                                      [f.name, "cache", "max_size_mb"],
                                      "缓存空间（MiB）",
                                      "Cache size (MiB)",
                                      1,
                                      102400,
                                    )}
                                    {toggle(
                                      [f.name, "cache", "stale"],
                                      "上游异常时使用旧缓存",
                                      "Serve stale on upstream errors",
                                    )}
                                    {number(
                                      [f.name, "requests_per_second"],
                                      "每IP每秒请求数（0不限）",
                                      "Requests per second per IP (0 unlimited)",
                                      0,
                                      100000,
                                    )}
                                    {number(
                                      [f.name, "burst"],
                                      "突发请求数",
                                      "Burst requests",
                                      0,
                                      100000,
                                    )}
                                    {number(
                                      [f.name, "connections"],
                                      "每IP连接数（0不限）",
                                      "Connections per IP (0 unlimited)",
                                      0,
                                      100000,
                                    )}
                                    {number(
                                      [f.name, "body_size_mb"],
                                      "路径上传上限（MiB，空为继承）",
                                      "Route body limit (MiB, blank inherits)",
                                      0,
                                      102400,
                                    )}
                                  </div>
                                </>
                              ),
                            },
                            {
                              key: "headers",
                              label: t(
                                "请求头与响应头",
                                "Request and response headers",
                              ),
                              children: (
                                <>
                                  {text(
                                    [f.name, "request_headers_text"],
                                    "上游请求头（每行 名称: 值）",
                                    "Upstream headers (one Name: Value per line)",
                                    "X-Request-ID: $request_id",
                                  )}
                                  {text(
                                    [f.name, "response_headers_text"],
                                    "路径响应头（每行 名称: 值）",
                                    "Route response headers (one Name: Value per line)",
                                    "X-Content-Type-Options: nosniff",
                                  )}
                                  {tags(
                                    [f.name, "hide_headers"],
                                    "隐藏上游响应头",
                                    "Hide upstream response headers",
                                  )}
                                </>
                              ),
                            },
                            {
                              key: "security",
                              label: t(
                                "跨域与访问控制",
                                "CORS and access control",
                              ),
                              children: (
                                <>
                                  {toggle(
                                    [f.name, "cors", "enabled"],
                                    "启用跨域及OPTIONS预检",
                                    "Enable CORS and OPTIONS preflight",
                                  )}
                                  <div className="lm-ops-grid">
                                    {input(
                                      [f.name, "cors", "origin"],
                                      "允许来源",
                                      "Allowed origin",
                                      "https://app.example.com",
                                    )}
                                    {toggle(
                                      [f.name, "cors", "credentials"],
                                      "允许携带凭据",
                                      "Allow credentials",
                                    )}
                                    {input(
                                      [f.name, "cors", "methods"],
                                      "允许方法",
                                      "Allowed methods",
                                      "GET, POST, PUT, OPTIONS",
                                    )}
                                    {input(
                                      [f.name, "cors", "headers"],
                                      "允许请求头",
                                      "Allowed request headers",
                                      "Content-Type, Authorization",
                                    )}
                                    {number(
                                      [f.name, "cors", "max_age"],
                                      "预检缓存（秒）",
                                      "Preflight max age (s)",
                                    )}
                                    {tags(
                                      [f.name, "allow"],
                                      "允许IP / CIDR",
                                      "Allow IPs / CIDRs",
                                    )}
                                    {tags(
                                      [f.name, "deny"],
                                      "拒绝IP / CIDR",
                                      "Deny IPs / CIDRs",
                                    )}
                                  </div>
                                </>
                              ),
                            },
                            {
                              key: "custom",
                              label: t(
                                "自定义location配置",
                                "Custom location directives",
                              ),
                              children: text(
                                [f.name, "custom_config"],
                                "Location补充片段",
                                "Additional location directives",
                                "proxy_cookie_path / /app/;",
                              ),
                            },
                          ]}
                        />
                      </>
                    );
                  }}
                </Form.Item>
              </div>
            ))}
          </div>
        )}
      </Form.List>}
      {showSiteOptions && <Collapse
        items={[
          {
            key: "common",
            label: t(
              "站点：请求限制、压缩与日志",
              "Site: request limits, compression and logs",
            ),
            children: (
              <div className="lm-ops-grid">
                {number(
                  [...p, "body_size_mb"],
                  "上传上限（MiB，0不限）",
                  "Body limit (MiB, 0 unlimited)",
                  0,
                  102400,
                )}
                {number(
                  [...p, "keepalive_seconds"],
                  "客户端连接保活（秒）",
                  "Client keepalive (s)",
                )}
                {toggle([...p, "gzip"], "启用Gzip压缩", "Enable Gzip")}
                {number(
                  [...p, "gzip_level"],
                  "压缩等级",
                  "Compression level",
                  1,
                  9,
                )}
                {toggle([...p, "access_log"], "访问日志", "Access log")}
                {select(
                  [...p, "error_log_level"],
                  "错误日志等级",
                  "Error log level",
                  [
                    ["warn", "警告", "Warn"],
                    ["error", "错误", "Error"],
                    ["info", "信息", "Info"],
                    ["debug", "调试", "Debug"],
                    ["notice", "通知", "Notice"],
                    ["crit", "严重", "Critical"],
                  ],
                )}
              </div>
            ),
          },
          {
            key: "tls",
            label: t("站点：HTTPS与HTTP/2", "Site: HTTPS and HTTP/2"),
            children: (
              <>
                <div className="lm-ops-grid">
                  {toggle(
                    [...p, "redirect_https"],
                    "HTTP自动跳转HTTPS",
                    "Redirect HTTP to HTTPS",
                  )}
                  {toggle(
                    [...p, "http2"],
                    "启用HTTP/2（HTTPS）",
                    "Enable HTTP/2 (HTTPS)",
                  )}
                </div>
                <Form.Item
                  name={[...p, "tls_protocols"]}
                  label={t("TLS协议", "TLS protocols")}
                >
                  <Select
                    mode="multiple"
                    options={["TLSv1.2", "TLSv1.3"].map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                </Form.Item>
              </>
            ),
          },
          {
            key: "headers",
            label: t(
              "站点：响应头与访问控制",
              "Site: response headers and access control",
            ),
            children: (
              <>
                {text(
                  [...p, "response_headers_text"],
                  "站点响应头（每行 名称: 值）",
                  "Site response headers (one Name: Value per line)",
                  "Strict-Transport-Security: max-age=31536000",
                )}
                {tags(
                  [...p, "allow"],
                  "站点允许IP / CIDR",
                  "Site allow IPs / CIDRs",
                )}
                {tags(
                  [...p, "deny"],
                  "站点拒绝IP / CIDR",
                  "Site deny IPs / CIDRs",
                )}
              </>
            ),
          },
          ...(mode === "static"
            ? [
                {
                  key: "static",
                  label: t(
                    "静态文件：SPA、索引与缓存",
                    "Static files: SPA, indexes and cache",
                  ),
                  children: (
                    <>
                      <div className="lm-ops-grid">
                        {toggle(
                          [...p, "spa_fallback"],
                          "SPA路由回退到首页",
                          "SPA fallback to index",
                        )}
                        {toggle(
                          [...p, "autoindex"],
                          "显示目录列表",
                          "Directory listing",
                        )}
                        {number(
                          [...p, "expires_seconds"],
                          "浏览器缓存秒数（0不设置）",
                          "Browser cache seconds (0 unset)",
                          0,
                          31536000,
                        )}
                      </div>
                      {tags([...p, "index"], "默认索引文件", "Index files")}
                    </>
                  ),
                },
              ]
            : []),
          {
            key: "custom",
            label: t(
              "高级：自定义server配置",
              "Advanced: custom server directives",
            ),
            children: (
              <>
                <Alert
                  type="info"
                  showIcon
                  title={t(
                    "片段仅作用于本站点；不允许include、动态脚本或全局配置。发布前执行nginx -t，失败保留旧版。",
                    "Fragments stay within this site. Includes, dynamic scripts and global configuration are rejected. Deployment runs nginx -t and retains the previous version on failure.",
                  )}
                />
                {text(
                  [...p, "server_snippet"],
                  "Server补充片段",
                  "Additional server directives",
                  "client_body_timeout 30s;",
                )}
              </>
            ),
          },
        ]}
      />}
    </>
  );
}
