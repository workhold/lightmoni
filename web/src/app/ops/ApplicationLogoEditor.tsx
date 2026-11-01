import { useState } from "react";
import { Alert, Button, Modal, Space } from "../../shared/ui";
import { api } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { errorText, type Resource } from "./model";
import ApplicationLogoUpload from "./ApplicationLogoUpload";

export default function ApplicationLogoEditor({
  resource,
  onClose,
  onSaved,
}: {
  resource?: Resource;
  onClose: () => void;
  onSaved: (resource: Resource) => void;
}) {
  const { t } = useI18n(),
    [snapshot, setSnapshot] = useState<Resource | undefined>(resource),
    [value, setValue] = useState<string | null>(),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const conflict = error === "application_logo_conflict";
  const messages: Record<string, [string, string]> = {
    application_logo_conflict: [
      "Logo 已被其他人修改，请加载最新图片后再操作。",
      "The logo changed. Load the latest image before editing again.",
    ],
    invalid_application_logo: [
      "图片无效，请重新选择。",
      "The image is invalid. Choose another image.",
    ],
    application_logo_too_large: [
      "图片过大，请选择较小的图片。",
      "The image is too large. Choose a smaller image.",
    ],
  };
  async function save() {
    if (!snapshot || value === undefined || pending || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await api<{ resource: Resource }>(
        "/ops/resources/" + encodeURIComponent(snapshot.id) + "/logo",
        {
          method: "PUT",
          body: JSON.stringify({
            revision: snapshot.logo_revision ?? 0,
            data_url: value,
          }),
        },
      );
      onSaved(data.resource);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    if (!snapshot) return;
    setBusy(true);
    try {
      const data = await api<{ resource: Resource }>(
        "/ops/resources/" + encodeURIComponent(snapshot.id),
      );
      setSnapshot(data.resource);
      setValue(undefined);
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={!!resource}
      title={
        t("应用 Logo", "Application logo") +
        (resource ? " · " + resource.name : "")
      }
      onCancel={() => {
        if (!busy) onClose();
      }}
      destroyOnHidden
      footer={
        <Space>
          <Button disabled={busy} onClick={onClose}>
            {t("取消", "Cancel")}
          </Button>
          <Button
            type="primary"
            aria-label={t("保存 Logo", "Save logo")}
            onClick={() => void save()}
            disabled={value === undefined || conflict}
            loading={busy || pending}
          >
            {t("保存 Logo", "Save logo")}
          </Button>
        </Space>
      }
    >
      {error && (
        <Alert
          showIcon
          type="error"
          title={
            messages[error]
              ? t(...messages[error])
              : t(
                  "保存失败，图片已保留",
                  "Save failed; your image is preserved",
                )
          }
          description={messages[error] ? undefined : error}
          action={
            conflict ? (
              <Button disabled={busy} onClick={() => void reload()}>
                {t("加载最新 Logo", "Load latest logo")}
              </Button>
            ) : undefined
          }
        />
      )}
      {snapshot && (
        <ApplicationLogoUpload
          key={snapshot.id}
          name={snapshot.name}
          templateID={
            snapshot.spec.source?.template_id ??
            (["registry", "openresty"].includes(snapshot.spec.role)
              ? snapshot.spec.role
              : undefined)
          }
          existingURL={snapshot.logo_url}
          value={value}
          onChange={setValue}
          onPendingChange={setPending}
          disabled={busy}
        />
      )}
      <p className="lm-ops-note">
        {t(
          "只更改展示图片，不影响应用配置和运行。",
          "Changes the display image without changing application configuration or deployment.",
        )}
      </p>
    </Modal>
  );
}
