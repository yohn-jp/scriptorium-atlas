import { utf8Bytes } from './bytes.js';
import { fail } from './errors.js';

export const MAX_PATH_UTF8_BYTES = 1024;
export const MAX_PATH_DEPTH = 32;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function validateWorkspaceId(value: string): string {
  if (!ID_PATTERN.test(value) || value.length > 128) {
    fail('INVALID_INPUT', 'Workspace ID is invalid.');
  }
  return value;
}

export function validateOperationId(value: string): string {
  if (!ID_PATTERN.test(value) || value.length > 128) {
    fail('INVALID_INPUT', 'Operation ID is invalid.');
  }
  return value;
}

export function validateRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    fail('INVALID_PATH', 'File path must contain between 1 and 1024 characters.');
  }
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    fail('INVALID_PATH', 'Absolute paths, backslashes, and NUL are not allowed.');
  }
  if (utf8Bytes(value).byteLength > MAX_PATH_UTF8_BYTES || value.normalize('NFC') !== value) {
    fail('INVALID_PATH', 'File path must be NFC-normalized and at most 1024 UTF-8 bytes.');
  }
  const segments = value.split('/');
  if (segments.length > MAX_PATH_DEPTH || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail('INVALID_PATH', 'File path has an invalid or over-deep path segment.');
  }
  if (segments.some(segment => segment.toLocaleLowerCase('en-US') === '.git')) {
    fail('PERMISSION_DENIED', 'Git metadata paths are outside the Host Port.');
  }
  return value;
}

export function validateWorkspacePayloadPath(value: string): string {
  const path = validateRelativePath(value);
  if (caseFoldPath(path) === 'manifest.json') {
    fail('INVALID_PATH', 'manifest.json is reserved for the V1 workspace bundle manifest.', { path });
  }
  return path;
}

export function validateWorkspaceName(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_INPUT', 'Workspace name must contain 1–128 printable characters.');
  }
  return value.trim();
}

export function caseFoldPath(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('und');
}
