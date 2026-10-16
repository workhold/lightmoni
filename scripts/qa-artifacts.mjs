import { mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mediaRoot = resolve(root, 'artifacts/screenshots');

// Keep text reports beside their documentation; store QA media locally.
export function mediaDirectory(evidenceDirectory) {
  const source = resolve(evidenceDirectory);
  const sourcePath = relative(root, source);
  const mediaPath = relative(mediaRoot, source);
  const outside = path => path === '..' || path.startsWith('..' + sep) || isAbsolute(path);
  const directory = outside(sourcePath) || !outside(mediaPath)
    ? source
    : resolve(mediaRoot, sourcePath);
  mkdirSync(directory, { recursive: true });
  return directory;
}
