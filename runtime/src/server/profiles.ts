import { fail } from "../shared/http.js";
import type { Auth } from "./auth.js";
import type { Context } from "../shared/types.js";
const fields = [
  "user_id",
  "timezone",
  "email",
  "phone",
  "feishu_id",
  "dingtalk_id",
  "wecom_id",
  "source",
  "updated_at",
] as const;
const record = (v: any) => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail(400, "个人资料格式无效");
  return v as Record<string, any>;
};
const defaults = (id = "") => ({
  user_id: id,
  timezone: "Asia/Shanghai",
  email: "",
  phone: "",
  feishu_id: "",
  dingtalk_id: "",
  wecom_id: "",
  source: "",
  updated_at: "",
});
export function notificationProfile(a: Auth, id: string): any {
  const p = defaults(id),
    row = a.db.get<any>(
      "SELECT body FROM user_notification_profiles WHERE user_id=?",
      id,
    );
  if (row)
    try {
      const saved = JSON.parse(row.body);
      for (const f of fields)
        if (typeof saved?.[f] === "string") p[f] = saved[f];
    } catch {}
  p.user_id = id;
  return p;
}
function validEmail(value: string) {
  if (/[\r\n\u0000-\u001f\u007f]/.test(value)) return false;
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) return false;
  const local = value.slice(0, at),
    domain = value.slice(at + 1);
  // mail.ParseAddress also accepts local domains, e.g. ops@localhost.
  const atom = /^[^\s()<>\[\]:;@\\",.]+$/u;
  const quoted =
    local.startsWith('"') &&
    local.endsWith('"') &&
    /^"(?:[^"\\]|\\[\x20-\x7e])+"$/.test(local);
  if (!quoted && !local.split(".").every((p) => atom.test(p))) return false;
  if (
    quoted &&
    local
      .slice(1, -1)
      .split(".")
      .every((p) => atom.test(p))
  )
    return false; // Go normalizes unnecessary quotes.
  if (domain.startsWith("[")) return /^\[[0-9A-Fa-f:.]+\]$/.test(domain);
  return domain.split(".").every((p) => atom.test(p));
}
export function validateContact(value: any) {
  const input = record(value),
    p = defaults();
  for (const f of fields) {
    if (input[f] != null && typeof input[f] !== "string")
      fail(400, "无效的联系方式");
    if (input[f] != null) p[f] = input[f];
  }
  p.email = p.email.trim();
  p.phone = p.phone.trim().replace(/[ -]/g, "");
  if (p.email && !validEmail(p.email)) fail(400, "请输入有效的收件邮箱");
  if (/^1[3-9][0-9]{9}$/.test(p.phone)) p.phone = "+86" + p.phone;
  if (p.phone && !/^\+[1-9][0-9]{6,14}$/.test(p.phone))
    fail(400, "手机号需要国家区号，例如 +8613800000000");
  p.timezone ||= "Asia/Shanghai";
  try {
    if (p.timezone !== "Local")
      new Intl.DateTimeFormat("en", { timeZone: p.timezone });
  } catch {
    fail(400, "无效的时区");
  }
  for (const f of ["feishu_id", "dingtalk_id", "wecom_id"] as const)
    if (Buffer.byteLength(p[f]) > 256 || /[\r\n]/.test(p[f]))
      fail(400, "无效的通知用户 ID");
  return p;
}
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const n of bytes) {
    crc ^= n;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
function pngSize(b: Buffer): [number, number] {
  if (
    b.length < 33 ||
    !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    b.readUInt32BE(8) !== 13 ||
    b.toString("ascii", 12, 16) !== "IHDR" ||
    crc32(b.subarray(12, 29)) !== b.readUInt32BE(29)
  )
    return [0, 0];
  const bit = b[24],
    color = b[25],
    depths: Record<number, number[]> = {
      0: [1, 2, 4, 8, 16],
      2: [8, 16],
      3: [1, 2, 4, 8],
      4: [8, 16],
      6: [8, 16],
    };
  if (!depths[color]?.includes(bit) || b[26] !== 0 || b[27] !== 0 || b[28] > 1)
    return [0, 0];
  if (color === 3) {
    let palette = false,
      ready = false;
    for (let i = 33; i + 12 <= b.length; ) {
      const n = b.readUInt32BE(i);
      if (n > b.length - i - 12) break;
      const kind = b.toString("ascii", i + 4, i + 8);
      if (crc32(b.subarray(i + 4, i + 8 + n)) !== b.readUInt32BE(i + 8 + n))
        return [0, 0];
      if (kind === "PLTE") {
        if (palette || n === 0 || n % 3 || n > 768) return [0, 0];
        palette = true;
      }
      if (kind === "tRNS") {
        if (!palette || n > 256) return [0, 0];
        ready = true;
        break;
      }
      if (kind === "IDAT") {
        ready = palette;
        break;
      }
      if (kind === "IEND" || kind === "IHDR") break;
      i += n + 12;
    }
    if (!ready) return [0, 0];
  }
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
function jpegSize(b: Buffer): [number, number] {
  if (b[0] !== 255 || b[1] !== 216) return [0, 0];
  let dimensions: [number, number] = [0, 0],
    jfif = false;
  for (let i = 2; i + 1 < b.length; ) {
    if (b[i++] !== 255) return [0, 0];
    while (b[i] === 255) i++;
    const marker = b[i++];
    if (marker === 217) return dimensions;
    if (marker >= 208 && marker <= 215) continue;
    if (i + 2 > b.length) return [0, 0];
    const n = b.readUInt16BE(i);
    if (n < 2 || i + n > b.length) return [0, 0];
    if (marker === 218) return dimensions;
    if ([192, 193, 194].includes(marker)) {
      const count = b[i + 7];
      if (
        dimensions[0] ||
        ![1, 3, 4].includes(count) ||
        n !== 8 + 3 * count ||
        b[i + 2] !== 8
      )
        return [0, 0];
      const ids = new Set<number>(),
        sampling: number[] = [];
      for (let j = 0; j < count; j++) {
        const at = i + 8 + 3 * j,
          c = b[at],
          h = b[at + 1] >> 4,
          v = b[at + 1] & 15;
        if (
          ids.has(c) ||
          ![1, 2, 4].includes(h) ||
          ![1, 2, 4].includes(v) ||
          b[at + 2] > 3
        )
          return [0, 0];
        ids.add(c);
        sampling.push(b[at + 1]);
      }
      if (
        count === 4 &&
        (![17, 34].includes(sampling[0]) ||
          sampling[1] !== 17 ||
          sampling[2] !== 17 ||
          sampling[3] !== sampling[0])
      )
        return [0, 0];
      dimensions = [b.readUInt16BE(i + 5), b.readUInt16BE(i + 3)];
      if (jfif) return dimensions;
    } else if (marker === 224) {
      jfif = n >= 7 && b.toString("ascii", i + 2, i + 7) === "JFIF\0";
    } else if (
      !(
        [196, 219, 221, 254].includes(marker) ||
        (marker >= 224 && marker <= 239)
      )
    )
      return [0, 0];
    i += n;
  }
  return [0, 0];
}
// Validate bounded raster metadata like Go image.DecodeConfig; never fetch an avatar URL.
export function validateAvatar(value: string) {
  if (!value) return;
  if (value.length > 350000) fail(400, "头像不能超过 256 KB");
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(
    value,
  );
  if (!m) fail(400, "头像仅支持 PNG 或 JPEG 图片");
  if (m[2].length % 4) fail(400, "头像无效或超过 256 KB");
  const b = Buffer.from(m[2], "base64");
  if (b.length > 256 * 1024) fail(400, "头像无效或超过 256 KB");
  const [w, h] = m[1] === "png" ? pngSize(b) : jpegSize(b);
  if (w < 1 || h < 1 || w > 4096 || h > 4096)
    fail(400, "请输入有效的 PNG 或 JPEG 头像，尺寸不超过 4096 像素");
}
export function registerProfiles(a: Auth) {
  const r = a.router,
    db = a.db;
  const target = (c: Context) => {
    const uid = c.params.id || c.user.id;
    if (uid !== c.user.id && c.user.role !== "admin")
      fail(403, "只能查看或修改自己的告警联系方式");
    return uid;
  };
  for (const path of [
    "/api/v1/auth/notification-profile",
    "/api/v1/users/:id/notification-profile",
  ]) {
    r.get(path, (c) => c.json(notificationProfile(a, target(c))));
    r.put(path, async (c) => {
      const uid = target(c),
        p = validateContact(await c.body());
      if (!db.get("SELECT id FROM users WHERE id=?", uid))
        fail(404, "用户不存在");
      Object.assign(p, {
        user_id: uid,
        source: "manual",
        updated_at: new Date().toISOString(),
      });
      db.run(
        "INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body",
        uid,
        JSON.stringify(p),
      );
      c.json(p);
    });
  }
  const visible = (nick: string, avatar: string, p: any) => ({
    nickname: nick,
    avatar_url: avatar,
    phone: p.phone,
    email: p.email,
    feishu_id: p.feishu_id,
    dingtalk_id: p.dingtalk_id,
    wecom_id: p.wecom_id,
  });
  r.get("/api/v1/auth/profile", (c) =>
    c.json(
      visible(
        c.user.nickname ?? "",
        c.user.avatar_url ?? "",
        notificationProfile(a, c.user.id),
      ),
    ),
  );
  r.put("/api/v1/auth/profile", async (c) => {
    const v = record(await c.body());
    for (const f of [
      "nickname",
      "avatar_url",
      "phone",
      "email",
      "feishu_id",
      "dingtalk_id",
      "wecom_id",
    ])
      if (v[f] != null && typeof v[f] !== "string")
        fail(400, "个人资料格式无效");
    const nick = (v.nickname ?? "").trim(),
      avatar = v.avatar_url ?? "";
    if ([...nick].length > 40 || /\p{Cc}/u.test(nick))
      fail(400, "昵称最多 40 个字符，不能包含控制字符");
    validateAvatar(avatar);
    let p: any;
    db.transaction(() => {
      p = notificationProfile(a, c.user.id);
      const before = JSON.stringify(p);
      p.phone = v.phone ?? "";
      for (const field of ["email", "feishu_id", "dingtalk_id", "wecom_id"])
        if (v[field] != null) p[field] = v[field];
      p = validateContact(p);
      if (JSON.stringify(p) !== before) {
        Object.assign(p, {
          source: "manual",
          updated_at: new Date().toISOString(),
        });
        db.run(
          "INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body",
          c.user.id,
          JSON.stringify(p),
        );
      }
      db.run(
        "INSERT INTO user_profiles(user_id,nickname,avatar_url) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET nickname=excluded.nickname,avatar_url=excluded.avatar_url",
        c.user.id,
        nick,
        avatar,
      );
    });
    c.json(visible(nick, avatar, p));
  });
}
