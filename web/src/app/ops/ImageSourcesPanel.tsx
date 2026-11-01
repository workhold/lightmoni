import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  Space,
  Switch,
  Typography,
} from "../../shared/ui";
import { api } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { errorText } from "./model";
type Rule = { source: string; target: string; allow_upstream: boolean };
type Settings = { revision: number; rules: Rule[] };

export default function ImageSourcesPanel() {
  const { t } = useI18n(),
    [form] = Form.useForm();
  const [saved, setSaved] = useState<Settings>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await api<Settings>("/ops/image-sources");
      setSaved(next);
      form.setFieldsValue({ rules: next.rules });
      setNotice("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const save = async () => {
    let values: Settings;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (!saved) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api<Settings>("/ops/image-sources", {
        method: "PUT",
        body: JSON.stringify({
          revision: saved.revision,
          rules: values.rules ?? [],
        }),
      });
      setSaved(next);
      form.setFieldsValue({ rules: next.rules });
      setNotice(
        t(
          "已保存；下次部署或重试时生效。",
          "Saved; used by the next deployment or retry.",
        ),
      );
    } catch (e) {
      const code = errorText(e);
      setError(
        code === "image_sources_revision_conflict"
          ? t(
              "配置已被其他人更新，输入已保留。重新载入会替换当前编辑内容。",
              "Settings changed elsewhere. Your input is retained; reload replaces your edits.",
            )
          : code.toLowerCase() === "invalid_image_sources"
            ? t(
                "请检查来源是否重复，代理是否为 HTTPS 仓库地址；不支持密码、查询参数和指向原源自身。",
                "Check duplicate sources and HTTPS registry addresses. Credentials, query parameters and the source itself are not supported.",
              )
            : code,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="lm-ops-panel"
      aria-label={t("镜像来源代理", "Image source proxies")}
    >
      <h3>{t("镜像来源代理", "Image source proxies")}</h3>
      <p>
        {t(
          "按来源仓库配置全局代理，无需安装私有仓库。适用于应用、Docker Registry 和 OpenResty 的后续部署；保存后不会重启现有容器或 Docker。",
          "Configure global proxies for specific source registries without installing a private registry. Used by future application, Docker Registry and OpenResty deployments. Saving does not restart containers or Docker.",
        )}
      </p>
      <Typography.Paragraph type="secondary">
        {t(
          "优先复用本机镜像和已配置的集群缓存。代理地址使用 HTTPS，可包含路径前缀；仅填写你信任的代理。来源登录凭据不会转交给代理，需要新版 Agent。",
          "Local images and configured cluster caches take priority. Use a trusted HTTPS proxy, optionally with a path prefix. Source credentials are not forwarded. Requires an updated Agent.",
        )}
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon title={error} />}
      {notice && <Alert type="success" showIcon title={notice} />}
      <Form form={form} layout="vertical" disabled={busy}>
        <Form.List name="rules">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <div className="lm-ops-panel" key={field.key}>
                  <Space align="start" wrap>
                    <Form.Item
                      name={[field.name, "source"]}
                      label={t("来源仓库", "Source registry")}
                      rules={[{ required: true }]}
                    >
                      <Input
                        placeholder="docker.io"
                        aria-label={t("来源仓库", "Source registry")}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "target"]}
                      label={t(
                        "代理仓库 / 路径前缀",
                        "Proxy registry / path prefix",
                      )}
                      rules={[
                        { required: true },
                        {
                          pattern: /^https:\/\/[^\s]+$/,
                          message: t(
                            "请填写 HTTPS 地址",
                            "Enter an HTTPS address",
                          ),
                        },
                      ]}
                    >
                      <Input
                        placeholder="https://m.daocloud.io/docker.io"
                        style={{ minWidth: 300 }}
                        aria-label={t(
                          "代理仓库 / 路径前缀",
                          "Proxy registry / path prefix",
                        )}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "allow_upstream"]}
                      label={t("代理失败后允许回源", "Allow origin fallback")}
                      valuePropName="checked"
                    >
                      <Switch
                        aria-label={t(
                          "代理失败后允许回源",
                          "Allow origin fallback",
                        )}
                      />
                    </Form.Item>
                    <Button onClick={() => remove(field.name)}>
                      {t("移除此规则", "Remove rule")}
                    </Button>
                  </Space>
                </div>
              ))}
              <Button
                disabled={busy || fields.length >= 20}
                onClick={() =>
                  add({ source: "", target: "", allow_upstream: false })
                }
              >
                {t("添加来源代理", "Add source proxy")}
              </Button>
            </>
          )}
        </Form.List>
        <p className="lm-ops-note">
          {t(
            "例如 docker.io → https://m.daocloud.io/docker.io。未配置的来源保持原有行为。默认代理失败即停止，开启回源后才会尝试原站。可变标签以代理提供的内容为准；需要固定内容时使用 @sha256 摘要。",
            "Example: docker.io → https://m.daocloud.io/docker.io. Unconfigured sources keep their current behavior. Origin fallback is off by default. Mutable tags use content supplied by the proxy; pin @sha256 for fixed content.",
          )}
        </p>
        <Space>
          <Button
            type="primary"
            loading={busy}
            disabled={!saved}
            onClick={() => void save()}
          >
            {t("保存镜像代理", "Save image proxies")}
          </Button>
          <Button disabled={busy} onClick={() => void load()}>
            {t("重新载入代理配置", "Reload proxy settings")}
          </Button>
        </Space>
      </Form>
    </section>
  );
}
