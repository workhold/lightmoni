import { useState } from "react";
import { AppstoreOutlined } from "@ant-design/icons";

const assets = import.meta.glob(
  "../../assets/application-logos/*.{svg,png,webp,jpg,jpeg}",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;
export const brandLogos = Object.fromEntries(
  Object.entries(assets).map(([path, url]) => [
    path
      .split("/")
      .at(-1)!
      .replace(/\.[^.]+$/, ""),
    url,
  ]),
);

export default function ApplicationLogo({
  name,
  templateID,
  url,
}: {
  name: string;
  templateID?: string;
  url?: string;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const brand =
    templateID && Object.hasOwn(brandLogos, templateID)
      ? brandLogos[templateID]
      : undefined;
  const src = [url, brand].find((v) => v && !failed.includes(v));
  return (
    <span className="lm-app-icon lm-application-logo">
      {src ? (
        <img
          src={src}
          alt={name + " logo"}
          onError={() =>
            setFailed((old) => (old.includes(src) ? old : [...old, src]))
          }
        />
      ) : (
        <AppstoreOutlined aria-hidden />
      )}
    </span>
  );
}
