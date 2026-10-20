import type { Asset } from '@scriptorium-atlas/contracts';
import { sha256Hex } from './host-utils.js';

export const IMAGE_MIME_TYPES = new Set<Asset['mime']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);

const ACTIVE_SVG_ELEMENTS = new Set([
  'script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video',
  'animate', 'animatemotion', 'animatetransform', 'set', 'discard', 'style', 'image',
]);

function sanitizeSvgText(input: string): string {
  if (!globalThis.DOMParser || !globalThis.XMLSerializer) throw new Error('このブラウザーではSVG画像を安全に検査できません。');
  const documentValue = new DOMParser().parseFromString(input, 'image/svg+xml');
  if (documentValue.querySelector('parsererror')) throw new Error('SVG画像のXML形式が正しくありません。');
  const root = documentValue.documentElement;
  if (root.localName.toLowerCase() !== 'svg') throw new Error('SVG画像のルート要素は<svg>である必要があります。');

  for (const element of [...documentValue.querySelectorAll('*')]) {
    const localName = element.localName.toLowerCase();
    if (ACTIVE_SVG_ELEMENTS.has(localName)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const isExternalReference = /^(?:https?:|\/\/|file:|javascript:|data:)/i.test(value);
      const unsafeStyle = name === 'style' && (/url\s*\(/i.test(value) && !/^.*url\(\s*#[^)]+\s*\).*$/.test(value)
        || /@import|expression\s*\(/i.test(value));
      if (name.startsWith('on') || (name === 'href' || name.endsWith(':href') || name === 'src') && (isExternalReference || !value.startsWith('#')) || unsafeStyle) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return new XMLSerializer().serializeToString(root);
}

export function sanitizeImageBytes(bytes: Uint8Array, mime: Asset['mime']): Uint8Array {
  if (!IMAGE_MIME_TYPES.has(mime)) throw new Error(`対応していない画像形式です: ${mime}。`);
  if (mime !== 'image/svg+xml') return bytes.slice();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return new TextEncoder().encode(sanitizeSvgText(text));
}

export async function verifyAssetBytes(asset: Asset, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength !== asset.bytes) throw new Error(`アセット ${asset.path} のサイズは${bytes.byteLength}バイトです（期待値: ${asset.bytes}バイト）。`);
  const hash = await sha256Hex(bytes);
  if (hash !== asset.sha256) throw new Error(`アセット ${asset.path} のSHA-256検証に失敗しました。`);
}

export function assetExtension(mime: Asset['mime']): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    default: return 'bin';
  }
}
