const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

const ACTIVE_ELEMENTS = new Set([
  'animate',
  'animatecolor',
  'animatemotion',
  'animatetransform',
  'discard',
  'embed',
  'foreignobject',
  'iframe',
  'link',
  'object',
  'script',
  'set',
  'style',
  'audio',
  'video'
]);

/** Return true only for SVG that is safe to display as an inline image. */
export function isSafeSvg(bytes: Uint8Array): boolean {
  const text = decodeUtf8(bytes);
  if (text === undefined || typeof DOMParser === 'undefined') return false;
  try {
    const document = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = document.documentElement;
    if (document.doctype || !root || root.localName.toLowerCase() !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) return false;
    if (document.querySelector('parsererror')) return false;
    if (hasProcessingInstruction(document)) return false;

    for (const element of Array.from(document.getElementsByTagName('*'))) {
      const name = element.localName.toLowerCase();
      if (element.namespaceURI !== SVG_NAMESPACE || ACTIVE_ELEMENTS.has(name)) return false;
      for (const attribute of Array.from(element.attributes)) {
        const localName = attribute.localName.toLowerCase();
        const namespace = attribute.namespaceURI;
        const value = attribute.value.trim();
        if (localName.startsWith('on')) return false;
        if (localName === 'href') {
          if (value.length === 0 || !value.startsWith('#')) return false;
          if (namespace !== null && namespace !== XLINK_NAMESPACE) return false;
        } else if (namespace === XLINK_NAMESPACE) {
          return false;
        }
        if (localName === 'base' || ['src', 'action', 'formaction', 'data', 'poster', 'background'].includes(localName)) return false;
        if (localName === 'style' || hasUnsafeCssReference(value)) return false;
        if (namespace !== null && namespace !== XMLNS_NAMESPACE && namespace !== XML_NAMESPACE && namespace !== XLINK_NAMESPACE) return false;
        if (namespace === XML_NAMESPACE && localName !== 'lang' && localName !== 'space') return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Preserve bytes, but mark them as downloadable unless they pass the inline-safe SVG checks. */
export function svgContentType(bytes?: Uint8Array): 'image/svg+xml' | 'application/octet-stream' {
  return bytes && isSafeSvg(bytes) ? 'image/svg+xml' : 'application/octet-stream';
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function hasProcessingInstruction(document: XMLDocument): boolean {
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_PROCESSING_INSTRUCTION);
  return walker.nextNode() !== null;
}

function hasUnsafeCssReference(value: string): boolean {
  if (/\/\*|\*\/|\\|@import/iu.test(value)) return true;
  if (!/url/iu.test(value)) return false;
  const references = Array.from(value.matchAll(/url\s*\(([^)]*)\)/giu));
  return references.length === 0 || references.some((reference) => {
    const target = reference[1];
    return target === undefined || !/^(?:#[^\s'"]+|'#[^']+'|"#[^"]+")$/u.test(target.trim());
  });
}
