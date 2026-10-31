import { useEffect } from "react";
import { Form, Input, Select, Switch, Tag } from "../../shared/ui";
import { useI18n } from "../../shared/i18n";
import {
  type Resource,
  type Spec,
  websiteDomainClusters,
  websiteDomainPolicy,
} from "./model";
import WebsiteClusterPolicies from "./WebsiteClusterPolicies";

export default function WebsiteDomainRoutes({
  resources,
  clusterIds,
  editMembership = true,
}: {
  resources: Resource[];
  clusterIds: string[];
  editMembership?: boolean;
}) {
  const { t } = useI18n(),
    form = Form.useFormInstance();
  const bindings: Spec[] =
    Form.useWatch(["spec", "bindings"], { form, preserve: true }) ??
    form.getFieldValue(["spec", "bindings"]) ??
    [];
  const rows: Spec[] =
    Form.useWatch(["spec", "domain_routes"], { form, preserve: true }) ??
    form.getFieldValue(["spec", "domain_routes"]) ??
    [];
  const domains = [...new Set(bindings.flatMap((b) => b.domains ?? []))];
  useEffect(() => {
    const old: Spec[] = form.getFieldValue(["spec", "domain_routes"]) ?? [];
    const next = domains.map(
      (domain) => old.find((r) => r.domain === domain) ?? { domain },
    );
    if (JSON.stringify(next) !== JSON.stringify(old))
      form.setFieldValue(["spec", "domain_routes"], next);
  }, [JSON.stringify(domains), form]);
  return (
    <section className="lm-ops-domain-routes">
      <h3>{t("域名集群", "Clusters by domain")}</h3>
      <p className="lm-ops-note">
        {editMembership
          ? t(
              "每个域名默认跟随全部可用集群，也可单独选择。集群范围需发布生效，流量策略保存后独立生效。",
              "Each domain follows all available clusters by default, or uses its own selection. Publish cluster assignments; traffic policies take effect independently.",
            )
          : t(
              "这里仅调整域名流量；修改绑定集群请编辑网站并发布。未设置独立策略时继承网站默认策略。",
              "Adjust domain traffic here. Edit and publish the website to change cluster assignments. Domains inherit the website defaults unless overridden.",
            )}
      </p>
      <Form.List name={["spec", "domain_routes"]}>
        {(fields) => (
          <>
            {fields.map((f) => {
              const row = rows[f.name] ?? {},
                selected = websiteDomainClusters(
                  { domain_routes: [row] },
                  row.domain,
                  clusterIds,
                ),
                path = ["spec", "domain_routes", f.name];
              return (
                <div className="lm-ops-mount lm-ops-domain-route" key={f.key}>
                  <div className="lm-ops-subheading">
                    <strong>{row.domain}</strong>
                    <Tag>
                      {row.cluster_ids === undefined
                        ? t("跟随全部集群", "Follow all clusters")
                        : t("指定集群", "Selected clusters")}
                    </Tag>
                  </div>
                  <Form.Item name={[f.name, "domain"]} hidden>
                    <Input />
                  </Form.Item>
                  {editMembership ? (
                    <>
                      <Form.Item
                        label={t("集群绑定方式", "Cluster assignment")}
                      >
                        <Select
                          aria-label={t("集群绑定方式", "Cluster assignment")}
                          value={
                            row.cluster_ids === undefined ? "all" : "selected"
                          }
                          options={[
                            {
                              value: "all",
                              label: t(
                                "跟随全部可用集群",
                                "Follow all available clusters",
                              ),
                            },
                            {
                              value: "selected",
                              label: t("指定集群", "Select clusters"),
                            },
                          ]}
                          onChange={(value) =>
                            form.setFieldValue(
                              [...path, "cluster_ids"],
                              value === "all" ? undefined : [...clusterIds],
                            )
                          }
                        />
                      </Form.Item>
                      {row.cluster_ids !== undefined && (
                        <Form.Item
                          name={[f.name, "cluster_ids"]}
                          label={t("域名绑定集群", "Domain clusters")}
                          rules={[
                            {
                              required: true,
                              type: "array",
                              min: 1,
                              message: t(
                                "至少选择一个集群",
                                "Select at least one cluster",
                              ),
                            },
                          ]}
                        >
                          <Select
                            mode="multiple"
                            optionFilterProp="label"
                            options={clusterIds.map((id) => ({
                              value: id,
                              label:
                                resources.find((r) => r.id === id)?.name ?? id,
                            }))}
                          />
                        </Form.Item>
                      )}
                    </>
                  ) : (
                    <p>
                      {selected.map((id) => (
                        <Tag key={id}>
                          {resources.find((r) => r.id === id)?.name ?? id}
                        </Tag>
                      ))}
                    </p>
                  )}
                  <Form.Item
                    name={[f.name, "custom_policy"]}
                    label={t("独立流量策略", "Override traffic policy")}
                    valuePropName="checked"
                  >
                    <Switch
                      onChange={(enabled) => {
                        if (enabled) {
                          const spec = form.getFieldValue("spec") ?? {};
                          form.setFieldValue(
                            [...path, "cluster_policies"],
                            selected.map((id) =>
                              websiteDomainPolicy(spec, row.domain, id),
                            ),
                          );
                        } else
                          form.setFieldValue(
                            [...path, "cluster_policies"],
                            undefined,
                          );
                      }}
                    />
                  </Form.Item>
                  {row.custom_policy && (
                    <WebsiteClusterPolicies
                      resources={resources}
                      clusterIds={selected}
                      namePath={[f.name, "cluster_policies"]}
                      valuePath={[...path, "cluster_policies"]}
                      domains={[row.domain]}
                      title={t("此域名的集群流量", "Traffic for this domain")}
                      showNote={false}
                    />
                  )}
                </div>
              );
            })}
          </>
        )}
      </Form.List>
    </section>
  );
}
