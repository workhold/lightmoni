import { useState } from "react";
import { Button, Modal } from "../../shared/ui";
import { useI18n } from "../../shared/i18n";
import sources from "../../assets/application-logos/sources.json";
const licenses = import.meta.glob(
  "../../assets/application-logos/*-license.txt",
  { eager: true, query: "?url&no-inline", import: "default" },
) as Record<string, string>;
const licenseURL = (name: string) =>
  licenses["../../assets/application-logos/" + name];
export default function LogoCredits() {
  const { t } = useI18n(),
    [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" type="link" onClick={() => setOpen(true)}>
        {t("Logo 来源与许可", "Logo sources and licenses")}
      </Button>
      <Modal
        open={open}
        title={t("Logo 来源与许可", "Logo sources and licenses")}
        onCancel={() => setOpen(false)}
        footer={
          <Button onClick={() => setOpen(false)}>{t("关闭", "Close")}</Button>
        }
      >
        <p>
          {t(
            "品牌名称和图形归各自所有者，展示用于标识对应应用。",
            "Brand names and logos belong to their respective owners and identify the corresponding applications.",
          )}
        </p>
        {sources.assets.map((asset) => (
          <p key={asset.id}>
            <a href={asset.source_url} target="_blank" rel="noreferrer">
              {asset.title}
            </a>
            {" · "}
            <a
              href={licenseURL(asset.license_file)}
              target="_blank"
              rel="noreferrer"
            >
              {asset.license}
            </a>
            {"upstream_brand_license" in asset &&
              asset.upstream_brand_license && (
                <>
                  {" "}
                  ·{" "}
                  <a
                    href={asset.upstream_brand_license.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {asset.upstream_brand_license.type}
                  </a>
                </>
              )}
            {"attribution" in asset && asset.attribution && (
              <small className="lm-ops-note">
                {"attribution_url" in asset && asset.attribution_url ? (
                  <a
                    href={asset.attribution_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {asset.attribution}
                  </a>
                ) : (
                  asset.attribution
                )}
              </small>
            )}
          </p>
        ))}
      </Modal>
    </>
  );
}
