import type { Attachment } from './types';

const maxFileBytes = 10 << 20;
const maxImageBytes = 512 << 10;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(binary);
}

async function imageAttachment(file: File): Promise<Attachment> {
  const url = URL.createObjectURL(file);
  try {
    const source = new Image();
    source.src = url;
    await source.decode();
    if (!source.naturalWidth || !source.naturalHeight || source.naturalWidth * source.naturalHeight > 100_000_000) throw Error('invalid image dimensions');
    let edge = 1600;
    for (let attempt = 0; attempt < 5; attempt++, edge = Math.floor(edge * .75)) {
      const scale = Math.min(1, edge / Math.max(source.naturalWidth, source.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw Error('image canvas unavailable');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .82 - attempt * .07));
      canvas.width = 0; canvas.height = 0;
      if (blob && blob.size <= maxImageBytes) return { kind: 'image', name: file.name, mime_type: 'image/jpeg', data: base64(new Uint8Array(await blob.arrayBuffer())) };
    }
    throw Error('image exceeds supported size after resizing');
  } finally { URL.revokeObjectURL(url); }
}

async function pdfAttachment(file: File): Promise<Attachment> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const task = pdfjs.getDocument({data: new Uint8Array(await file.arrayBuffer())});
  try {
    const document = await task.promise;
    if (document.numPages > 40) throw Error('PDF has more than 40 pages');
    const pages: string[] = [];
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => 'str' in item ? item.str : '').join(' '));
    }
    const text = pages.map((page, index) => `[Page ${index + 1}] ${page}`).join('\n').trim();
    if (!text.replace(/\[Page \d+\]/g, '').trim()) throw Error('PDF contains no selectable text; use a text PDF');
    if (text.length > 24_000 || new TextEncoder().encode(text).length > (96 << 10)) throw Error('PDF extracted text exceeds the 24,000 character limit');
    return { kind: 'pdf', name: file.name, mime_type: 'application/pdf', text, pages: document.numPages };
  } finally { await task.destroy(); }
}

export async function readAttachment(file: File): Promise<Attachment> {
  if (!file.name || file.name.length > 120 || /[\\/\p{Cc}]/u.test(file.name)) throw Error('Invalid attachment name');
  if (file.size > maxFileBytes) throw Error('Attachment exceeds 10 MB');
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return pdfAttachment(file);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw Error('Only JPEG, PNG, WebP and PDF files are supported');
  return imageAttachment(file);
}
