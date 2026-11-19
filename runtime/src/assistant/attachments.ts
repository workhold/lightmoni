import { randomBytes } from "node:crypto";
import { AssistantError, bytes, type Attachment, type Message } from "./types.js";

const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxImageBytes = 512 << 10;
const maxImageTotal = 1 << 20;
const maxPdfText = 24_000;

export interface StoredAttachment { ref: Attachment; content: string }

function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120 &&
    value.trim() === value && !/[\\/\p{Cc}]/u.test(value);
}
function validImage(data: Buffer, mime: string): boolean {
  if (mime === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mime === "image/png") return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
}

export function parseAttachments(value: unknown): StoredAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new AssistantError(400, "invalid assistant attachments");
  let imageBytes = 0;
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new AssistantError(400, "invalid assistant attachment");
    const input = item as Record<string, unknown>;
    if (!validName(input.name) || typeof input.mime_type !== "string") throw new AssistantError(400, "invalid assistant attachment name or type");
    const id = randomBytes(16).toString("hex");
    if (input.kind === "image" && imageTypes.has(input.mime_type) && typeof input.data === "string") {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.data) || input.data.length > Math.ceil(maxImageBytes / 3) * 4 + 4) throw new AssistantError(400, "invalid or oversized image attachment");
      const data = Buffer.from(input.data, "base64");
      if (data.length > maxImageBytes || data.toString("base64") !== input.data || !validImage(data, input.mime_type)) throw new AssistantError(400, "invalid or oversized image attachment");
      imageBytes += data.length;
      if (imageBytes > maxImageTotal) throw new AssistantError(400, "image attachments exceed total size limit");
      return { ref: { id, kind: "image", name: input.name, mime_type: input.mime_type }, content: input.data };
    }
    if (input.kind === "pdf" && input.mime_type === "application/pdf" && typeof input.text === "string" &&
      Number.isInteger(input.pages) && Number(input.pages) >= 1 && Number(input.pages) <= 40 &&
      input.text.trim() && input.text.length <= maxPdfText && bytes(input.text) <= (96 << 10) && !input.text.includes("\0")) {
      return { ref: { id, kind: "pdf", name: input.name, mime_type: "application/pdf", pages: Number(input.pages) }, content: input.text };
    }
    throw new AssistantError(400, "invalid or unreadable PDF attachment");
  });
}

export function attachmentMetadata(attachments: Attachment[]): Attachment[] {
  return attachments.map(({ kind, name, mime_type, pages }) => ({ kind, name, mime_type, ...(pages ? { pages } : {}) }));
}

// Keep the newest images available to the model and bound the stdin frame.
// Older attachment references remain in history and in the user's transcript.
export function hydrateAttachments(messages: Message[], read: (id: string) => string): Message[] {
  let imageBytes = 0, pdfBytes = 0;
  const result = structuredClone(messages);
  for (const message of result.reverse()) {
    for (const attachment of [...(message.attachments ?? [])].reverse()) {
      if (!attachment.id) continue;
      const content = read(attachment.id);
      if (attachment.kind === "image") {
        if (imageBytes + content.length > 1_400_000) continue;
        imageBytes += content.length;
        attachment.data = content;
      } else {
        if (pdfBytes + bytes(content) > (384 << 10)) continue;
        pdfBytes += bytes(content);
        attachment.text = content;
      }
    }
  }
  return result.reverse();
}
