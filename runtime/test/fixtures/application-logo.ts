import { crc32, deflateSync } from "node:zlib";
export function pngChunk(name: string, value: Buffer) {
  const part = Buffer.concat([Buffer.from(name), value]),
    out = Buffer.alloc(value.length + 12);
  out.writeUInt32BE(value.length);
  part.copy(out, 4);
  out.writeUInt32BE(crc32(part), out.length - 4);
  return out;
}
export function pngFixture(width = 2, height = 2, red = 200) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * (width * 4 + 1) + 1 + x * 4;
      rows[i] = red;
      rows[i + 3] = 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
export const pngData = (value = pngFixture()) =>
  "data:image/png;base64," + value.toString("base64");
