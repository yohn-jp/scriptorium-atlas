import { fail } from './errors.js';

const encoder = new TextEncoder();

export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeUtf8(value: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    return undefined;
  }
}

export function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value.slice() : new Uint8Array(value.slice(0));
}

export function copyArrayBuffer(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  const copy = copyBytes(value);
  return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
}

export function base64ToBytes(value: string): Uint8Array {
  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  let valid = value.length % 4 === 0 && (padding === 0 || value.length >= 4);
  for (let index = 0; valid && index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isAlphabet = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47;
    const isPadding = code === 61 && index >= value.length - padding;
    if (!isAlphabet && !isPadding) valid = false;
  }
  if (!valid) {
    fail('INVALID_INPUT', 'Base64 content is malformed.');
  }
  try {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    if (bytesToBase64(bytes) !== value) fail('INVALID_INPUT', 'Base64 content is not canonical.');
    return bytes;
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    fail('INVALID_INPUT', 'Base64 content is malformed.');
  }
}

export function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  // Keep argument count below browser/Node engine spread limits for multi-MiB assets.
  const chunkSize = 0x2000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const chunk = value.subarray(offset, Math.min(offset + chunkSize, value.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function sha256(value: Uint8Array | ArrayBuffer): Promise<string> {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.subtle) fail('STORAGE_UNAVAILABLE', 'Web Crypto SHA-256 is unavailable.');
  const digest = await cryptoObject.subtle.digest('SHA-256', copyArrayBuffer(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_INPUT', 'Non-finite numbers cannot be hashed.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).filter(key => object[key] !== undefined).sort(compareStrings);
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  fail('INVALID_INPUT', 'Payload contains a non-JSON value.');
}

export async function digestJson(value: unknown): Promise<string> {
  return sha256(utf8Bytes(stableJson(value)));
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
