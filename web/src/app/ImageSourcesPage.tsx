import ImageSourcesPanel from "./ops/ImageSourcesPanel";
import RegistryCredentialsPanel from "./ops/RegistryCredentialsPanel";
import "./operations.css";
export default function ImageSourcesPage({embedded=false}:{embedded?:boolean}) {
  return (
    <div className={embedded?"lm-image-sources-page":"lm-page lm-operations-page"}>

      <RegistryCredentialsPanel />
      <ImageSourcesPanel />
    </div>
  );
}
