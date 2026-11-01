import { useI18n } from "../shared/i18n";
import ImageSourcesPanel from "./ops/ImageSourcesPanel";
import "./operations.css";

export default function ImageSourcesPage() {
  const { t } = useI18n();
  return (
    <div className="lm-page lm-operations-page">
      <div className="lm-page-heading">
        <h1>{t("镜像源", "Image sources")}</h1>
      </div>
      <ImageSourcesPanel />
    </div>
  );
}
