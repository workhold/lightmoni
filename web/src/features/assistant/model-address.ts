export interface AddressCorrection {
  original: string;
  corrected: string;
  reason: string;
}

// Read the escaped path as entered. URL.pathname would normalize dot segments,
// and decoding it would conflate tenant%2Fprivate with tenant/private.
function addressParts(value: string): { origin: string; path: string } | undefined {
  const match = /^(https?:\/\/[^/?#]+)([^?#]*)$/i.exec(value);
  return match ? { origin: match[1], path: match[2] } : undefined;
}

function sameService(original: string, corrected: string): boolean {
  try { return new URL(original).origin === new URL(corrected).origin; }
  catch { return false; }
}

// Describe only a correction already returned by the server; this function does
// not validate addresses, choose a protocol, or produce candidate URLs.
export function describeAddressCorrection(original: string, corrected: string): AddressCorrection | undefined {
  if (original === corrected) return undefined;

  const reasons: string[] = [];
  const trimmed = original.trim();
  if (trimmed !== original) reasons.push('已去除地址首尾空白');

  const before = addressParts(trimmed);
  const after = addressParts(corrected.trim());
  if (before && after && sameService(trimmed, corrected.trim())) {
    const path = before.path.replace(/\/+$/, '');
    const correctedPath = after.path.replace(/\/+$/, '');
    const endpoint = /(?:\/chat\/completions|\/responses|\/messages|\/models\/[^/]+:(?:generateContent|streamGenerateContent)|\/models)$/.exec(path);
    const basePath = endpoint ? path.slice(0, endpoint.index).replace(/\/+$/, '') : path;
    const versionAdded = basePath === '' && (correctedPath === '/v1' || correctedPath === '/v1beta');
    const versionReplaced = basePath.endsWith('/v1beta') && correctedPath === `${basePath.slice(0, -'/v1beta'.length)}/v1`;
    const pathExplained = correctedPath === basePath || versionAdded || versionReplaced;

    if (pathExplained && endpoint) reasons.push('已从完整接口地址提取 API 基址');
    if (versionAdded) reasons.push(`已补全模型目录可用的版本路径 ${correctedPath}`);
    if (versionReplaced) reasons.push('已按所选协议将版本路径 /v1beta 修正为 /v1');
    if (pathExplained && before.path.endsWith('/') && !after.path.endsWith('/')) reasons.push('已去除地址末尾多余的 /');
    if (!pathExplained || before.origin !== after.origin) reasons.push('已规范化 API 基址格式');
  }

  if (reasons.length === 0) reasons.push('已规范化 API 基址格式');
  return { original, corrected, reason: reasons.join('；') };
}
