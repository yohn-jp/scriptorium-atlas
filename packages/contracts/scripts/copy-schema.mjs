import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const packageDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(packageDir, '../../..');
const outDir = resolve(packageDir, '../dist/generated');
await mkdir(outDir, { recursive: true });
await copyFile(resolve(rootDir, 'docs/contracts/v1.schema.json'), resolve(outDir, 'v1.schema.json'));
await copyFile(resolve(packageDir, '../src/generated/validators.runtime.js'), resolve(outDir, 'validators.runtime.js'));
await copyFile(resolve(packageDir, '../src/generated/validators.runtime.d.ts'), resolve(outDir, 'validators.runtime.d.ts'));
