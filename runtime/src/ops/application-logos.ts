import { createHash } from "node:crypto";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { fail } from "../shared/http.js";

export const MAX_LOGO_BYTES = 256 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const invalid = () => fail(400, "invalid_application_logo");
const chunk = (name: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(name), data]);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
};

/** Decode a bounded bitmap and re-encode it without ancillary data or trailing streams. */
export function applicationLogo(input: unknown) {
  if (typeof input !== "string") invalid();
  if ((input as string).length > Math.ceil(MAX_LOGO_BYTES / 3) * 4 + 22)
    fail(413, "application_logo_too_large");
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    input as string,
  );
  if (!match) invalid();
  const png = Buffer.from(match![1], "base64");
  if (
    png.toString("base64") !== match![1] ||
    !png.subarray(0, 8).equals(signature)
  )
    invalid();
  if (png.length > MAX_LOGO_BYTES) fail(413, "application_logo_too_large");
  let header: Buffer | undefined,
    ended = false,
    dataEnded = false,
    offset = 8;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    if (offset + 12 > png.length) invalid();
    const length = png.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > png.length) invalid();
    const name = png.toString("ascii", offset + 4, offset + 8);
    if (
      !/^[A-Za-z]{4}$/.test(name) ||
      crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)
    )
      invalid();
    const body = png.subarray(offset + 8, end - 4);
    if (!header && name !== "IHDR") invalid();
    if (name === "IHDR") {
      if (header || length !== 13) invalid();
      header = body;
      const width = body.readUInt32BE(0),
        height = body.readUInt32BE(4);
      if (
        !width ||
        !height ||
        width > 512 ||
        height > 512 ||
        body[8] !== 8 ||
        ![2, 6].includes(body[9]) ||
        body[10] ||
        body[11] ||
        body[12]
      )
        invalid();
    } else if (name === "IDAT") {
      if (dataEnded) invalid();
      compressed.push(body);
    } else if (name === "IEND") {
      if (length || !compressed.length || end !== png.length) invalid();
      ended = true;
    } else {
      if (name[0] === name[0].toUpperCase()) invalid();
      if (compressed.length) dataEnded = true;
    }
    offset = end;
  }
  if (!header || !ended) invalid();
  const width = header!.readUInt32BE(0),
    height = header!.readUInt32BE(4);
  const stride = width * (header![9] === 6 ? 4 : 3) + 1,
    size = stride * height;
  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: size });
  } catch {
    return invalid();
  }
  if (pixels.length !== size) invalid();
  for (let row = 0; row < height; row++)
    if (pixels[row * stride] > 4) invalid();
  const content = Buffer.concat([
    signature,
    chunk("IHDR", header!),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  if (content.length > MAX_LOGO_BYTES) fail(413, "application_logo_too_large");
  return {
    content,
    base64: content.toString("base64"),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
