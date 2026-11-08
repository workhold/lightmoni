import ImageSourcesPanel from "./ops/ImageSourcesPanel";
import RegistryCredentialsPanel from "./ops/RegistryCredentialsPanel";
import "./operations.css";
export default function ImageSourcesPage() {
  return (
    <div className="lm-page lm-operations-page">

      <RegistryCredentialsPanel />
      <ImageSourcesPanel />
    </div>
  );
}
