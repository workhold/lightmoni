import { useEffect, useState } from "react";
import {
  Alert,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Tag,
} from "../../shared/ui";
import { api } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { errorText, type Resource, type Spec } from "./model";

export default function WebsiteClusterPolicies({
  resources,
  clusterIds,
}: {
  resources: Resource[];
  clusterIds: string[];
}) {
  const { t } = useI18n(),
    form = Form.useFormInstance(),
    bindings: Spec[] =
      Form.useWatch(["spec", "bindings"], { form, preserve: true }) ?? [];
  const [lines, setLines] = useState<{ id: string; name: string }[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const zones = [
    ...new Set(
      bindings
        .filter((b) => b.dns_enabled && b.dns_zone_id)
        .map((b) => b.dns_zone_id as string),
    ),
  ]
    .sort()
    .join(",");
  useEffect(() => {
    const old: Spec[] = form.getFieldValue(["spec", "cluster_policies"]) ?? [];
    const next = clusterIds.map(
      (cluster_id) =>
        old.find((p) => p.cluster_id === cluster_id) ?? {
          cluster_id,
          enabled: true,
          weight: 1,
          default: true,
          lines: [],
        },
    );
    if (JSON.stringify(next) !== JSON.stringify(old))
      form.setFieldValue(["spec", "cluster_policies"], next);
  }, [clusterIds.join(","), form]);
  useEffect(() => {
    let active = true;
    setLines([]);
    setError("");
    if (!zones) return;
    setLoading(true);
    void Promise.all(
      zones
        .split(",")
        .map((id) =>
          api<{ lines: { id: string; name: string }[] }>(
            "/ops/resources/" + encodeURIComponent(id) + "/dns-lines",
          ),
        ),
    )
      .then((results) => {
        if (active)
          setLines(
            results[0].lines.filter((l) =>
              results.every((r) =>
                r.lines.some((x) => x.id === l.id && x.name === l.name),
              ),
            ),
          );
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [zones]);
  return (
    <section className="lm-ops-cluster-policies">
      <h3>{t("集群流量", "Cluster traffic")}</h3>
      <p className="lm-ops-note">
        {t(
          "默认按权重分流，关闭或故障时撤下解析。细分线路需域名套餐支持，无健康目标时回退默认。",
          "Default traffic follows relative weights; disabled or failed entries leave DNS. Detailed lines require provider plan support and fall back to the default when no healthy target remains.",
        )}
      </p>
      {error && (
        <Alert
          showIcon
          type="error"
          title={t("无法获取 DNS 线路", "Unable to load DNS lines")}
          description={error}
        />
      )}
      <Form.List name={["spec", "cluster_policies"]}>
        {(fields) => (
          <>
            {fields.map((f) => {
              const cid = clusterIds[f.name],
                gateway = resources
                  .find(
                    (r) =>
                      r.kind === "application" && r.spec.role === "openresty",
                  )
                  ?.spec.deployments?.find((d: Spec) => d.cluster_id === cid);
              return (
                <div className="lm-ops-mount" key={f.key}>
                  <div className="lm-ops-subheading">
                    <strong>
                      {resources.find((r) => r.id === cid)?.name ?? cid}
                    </strong>
                    <Tag>
                      {gateway?.gateway_domain ??
                        t("尚未设置入口域名", "Entry domain not configured")}
                    </Tag>
                  </div>
                  <Form.Item name={[f.name, "cluster_id"]} hidden>
                    <Input />
                  </Form.Item>
                  <div className="lm-ops-grid">
                    <Form.Item
                      name={[f.name, "enabled"]}
                      label={t("开启集群流量", "Enable cluster traffic")}
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      name={[f.name, "weight"]}
                      label={t("集群流量权重", "Cluster traffic weight")}
                      rules={[{ required: true }]}
                    >
                      <InputNumber min={1} max={100} precision={0} />
                    </Form.Item>
                  </div>
                  <Collapse
                    size="small"
                    items={[
                      {
                        key: "lines",
                        label: t(
                          "高级：运营商与省份线路",
                          "Advanced: carrier and province lines",
                        ),
                        children: (
                          <>
                            <Form.Item
                              name={[f.name, "default"]}
                              label={t("承接默认线路", "Serve default traffic")}
                              valuePropName="checked"
                            >
                              <Switch />
                            </Form.Item>
                            <Form.Item
                              name={[f.name, "lines"]}
                              label={t("承接线路", "Additional lines")}
                              getValueProps={(value: Spec[] = []) => ({
                                value: value.map((l) => l.id),
                              })}
                              getValueFromEvent={(ids: string[]) =>
                                ids.map(
                                  (id) =>
                                    lines.find((l) => l.id === id) ?? {
                                      id,
                                      name: id,
                                    },
                                )
                              }
                            >
                              <Select
                                mode="multiple"
                                loading={loading}
                                disabled={!zones || loading || !!error}
                                options={lines
                                  .filter(
                                    (l) =>
                                      !["default", "0"].includes(l.id) &&
                                      l.name !== "默认",
                                  )
                                  .map((l) => ({ value: l.id, label: l.name }))}
                                placeholder={
                                  zones
                                    ? t(
                                        "选择运营商或省份",
                                        "Select carrier or province",
                                      )
                                    : t(
                                        "先开启自动解析并选择托管域名",
                                        "Enable managed DNS and choose a zone first",
                                      )
                                }
                              />
                            </Form.Item>
                          </>
                        ),
                      },
                    ]}
                  />
                </div>
              );
            })}
          </>
        )}
      </Form.List>
    </section>
  );
}
