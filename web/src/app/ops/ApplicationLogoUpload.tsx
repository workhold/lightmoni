import { useEffect, useRef, useState } from "react";
import { UploadOutlined } from "@ant-design/icons";
import { Alert, Button, Space } from "../../shared/ui";
import { useI18n } from "../../shared/i18n";
import ApplicationLogo from "./ApplicationLogo";

export default function ApplicationLogoUpload({
  value,
  onChange,
  existingURL,
  templateID,
  name,
  disabled,
  onPendingChange,
}: {
  value?: string | null;
  onChange?: (v: string | null) => void;
  existingURL?: string;
  templateID?: string;
  name: string;
  disabled?: boolean;
  onPendingChange?: (value: boolean) => void;
}) {
  const { t } = useI18n(),
    input = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function select(file?: File) {
    if (!file) return;
    const current = ++generation.current;
    setError("");
    if (file.size > 5 * 1024 * 1024) {
      setPending(false);
      onPendingChange?.(false);
      setError(t("图片不能超过 5 MiB", "Image must be 5 MiB or smaller"));
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setPending(false);
      onPendingChange?.(false);
      setError(
        t("请选择 PNG、JPG 或 WebP 图片", "Choose a PNG, JPG or WebP image"),
      );
      return;
    }
    setPending(true);
    onPendingChange?.(true);
    let image: ImageBitmap | undefined;
    try {
      image = await createImageBitmap(file);
      if (
        !image.width ||
        !image.height ||
        image.width > 4096 ||
        image.height > 4096
      )
        throw Error("dimensions");
      const canvas = document.createElement("canvas");
      let result = "";
      for (const max of [256, 192]) {
        const scale = Math.min(1, max / image.width, max / image.height);
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw Error("canvas");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        result = canvas.toDataURL("image/png");
        if (result.length <= 349550) break;
      }
      if (result.length > 349550) throw Error("size");
      if (current === generation.current) onChange?.(result);
    } catch {
      if (current === generation.current)
        setError(
          t(
            "无法读取图片，请选择有效且尺寸不超过 4096 × 4096 的图片",
            "Could not read the image. Choose a valid image up to 4096 × 4096 pixels",
          ),
        );
    } finally {
      image?.close();
      if (current === generation.current) {
        setPending(false);
        onPendingChange?.(false);
      }
    }
  }
  return (
    <div className="lm-logo-upload">
      <Space wrap align="center">
        <ApplicationLogo
          name={name}
          templateID={templateID}
          url={value === undefined ? existingURL : (value ?? undefined)}
        />
        <Button
          aria-label={t("上传 Logo", "Upload logo")}
          icon={<UploadOutlined aria-hidden />}
          disabled={disabled}
          loading={pending}
          onClick={() => input.current?.click()}
        >
          {t("上传 Logo", "Upload logo")}
        </Button>
        <Button
          disabled={
            disabled ||
            pending ||
            !(value || (value === undefined && existingURL))
          }
          onClick={() => {
            generation.current++;
            setError("");
            onChange?.(null);
          }}
        >
          {t("使用默认 Logo", "Use default logo")}
        </Button>
      </Space>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-label={t("选择 Logo 图片", "Choose logo image")}
        hidden
        disabled={disabled}
        onChange={(e) => {
          void select(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <p className="lm-ops-note">
        {t(
          "PNG、JPG 或 WebP，最大 5 MiB，推荐正方形。",
          "PNG, JPG or WebP, up to 5 MiB. A square image works best.",
        )}
      </p>
      {error && <Alert type="error" showIcon title={error} />}
    </div>
  );
}
