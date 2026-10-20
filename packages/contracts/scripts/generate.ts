import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import type { AnySchemaObject } from 'ajv';

type JsonSchema = {
  $defs: Record<string, JsonSchema>;
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const canonicalSchemaPath = resolve(repositoryRoot, 'docs/contracts/v1.schema.json');
const generatedDir = resolve(packageRoot, 'src/generated');
const schema = JSON.parse(await readFile(canonicalSchemaPath, 'utf8')) as JsonSchema & { $schema: string; $id: string };

const aliases: Record<string, string> = {
  board: 'BoardDocument',
  card: 'CanvasCard',
};

function pascalCase(value: string): string {
  return value.replace(/(^|[-_])([a-z])/g, (_match, _prefix: string, letter: string) => letter.toUpperCase());
}

function nameFor(key: string): string {
  return aliases[key] ?? pascalCase(key);
}

function validatorNameFor(key: string): string {
  return `validate${nameFor(key)}`;
}

function propertyName(key: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(key) ? key : JSON.stringify(key);
}

function renderType(node: JsonSchema): string {
  if (node.$ref) {
    const match = node.$ref.match(/^#\/\$defs\/([^/]+)$/);
    if (!match) throw new Error(`Unsupported schema reference: ${node.$ref}`);
    return nameFor(match[1]!);
  }
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(' | ') || 'never';
  if (node.oneOf || node.anyOf) return (node.oneOf ?? node.anyOf)!.map(renderType).join(' | ') || 'never';
  if (node.allOf) {
    const base = { ...node };
    delete base.allOf;
    const parts: string[] = [];
    if (base.type || base.properties || base.$ref) parts.push(renderType(base));
    for (const part of node.allOf) {
      if ('if' in part || 'then' in part || 'else' in part) continue;
      parts.push(renderType(part));
    }
    const useful = parts.filter((part) => part !== 'unknown');
    return useful.join(' & ') || 'unknown';
  }
  if (Array.isArray(node.type)) return node.type.map((type) => renderType({ type } )).join(' | ');

  switch (node.type) {
    case 'array':
      return `Array<${renderType(node.items ?? {})}>`;
    case 'object': {
      const properties = Object.entries(node.properties ?? {});
      const additional = node.additionalProperties;
      if (properties.length === 0) {
        if (additional === false) return 'Record<string, never>';
        return `Record<string, ${typeof additional === 'object' ? renderType(additional) : 'unknown'}>`;
      }
      const required = new Set(node.required ?? []);
      const members = properties.map(([key, value]) =>
        `  ${propertyName(key)}${required.has(key) ? '' : '?'}: ${renderType(value)};`,
      );
      if (additional !== false) {
        const valueType = typeof additional === 'object' ? renderType(additional) : 'unknown';
        members.push(`  [key: string]: ${valueType};`);
      }
      return `{\n${members.join('\n')}\n}`;
    }
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    default:
      return 'unknown';
  }
}

const defs = Object.entries(schema.$defs);
const declarations = defs.map(([key, definition]) => `export type ${nameFor(key)} = ${renderType(definition)};`);
declarations.push('export type Board = BoardDocument;');
declarations.push('export type Card = CanvasCard;');
declarations.push('export type BoardView = View;');
declarations.push('export type TimelineAxis = NonNullable<View["axis"]>;');
declarations.push('');
declarations.push('export interface ContractTypes {');
for (const [key] of defs) declarations.push(`  ${JSON.stringify(key)}: ${nameFor(key)};`);
declarations.push('}\n');

await mkdir(generatedDir, { recursive: true });
await writeFile(resolve(generatedDir, 'types.ts'), `/* Generated from docs/contracts/v1.schema.json. Do not edit. */\n\n${declarations.join('\n')}\n`);

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true, code: { source: true, esm: true } });
ajv.addSchema(schema as AnySchemaObject);
const runtimeValidators: Record<string, string> = {};
for (const [key] of defs) {
  const validatorId = `${schema.$id}#/$defs/${key}`;
  if (!ajv.getSchema(validatorId)) throw new Error(`Could not compile schema validator: ${key}`);
  runtimeValidators[validatorNameFor(key)] = validatorId;
}
const runtimeCode = standaloneCode(ajv, runtimeValidators);
let runtimeCodeWithoutNodeRequire = runtimeCode.replace(
  /const (func\d+) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/g,
  'const $1 = atlasUcs2Length;',
);
if (/require\s*\(/.test(runtimeCodeWithoutNodeRequire)) {
  throw new Error('Standalone validators must not contain Node require calls.');
}
if (!runtimeCode.includes('require("ajv/dist/runtime/ucs2length").default')) {
  throw new Error('Ajv standalone output no longer includes the expected UCS-2 length helper.');
}
const ucs2LengthRuntimeHelper = `/* Adapted from Ajv 8.20.0 runtime/ucs2length.js (MIT License). */
function atlasUcs2Length(str) {
  const len = str.length;
  let length = 0;
  let pos = 0;
  let value;
  while (pos < len) {
    length++;
    value = str.charCodeAt(pos++);
    if (value >= 0xd800 && value <= 0xdbff && pos < len) {
      value = str.charCodeAt(pos);
      if ((value & 0xfc00) === 0xdc00) pos++;
    }
  }
  return length;
}
`;
await writeFile(
  resolve(generatedDir, 'validators.runtime.js'),
  `/* Generated from docs/contracts/v1.schema.json. Do not edit. */\n${ucs2LengthRuntimeHelper}\n${runtimeCodeWithoutNodeRequire}\n`,
);
const runtimeExports = defs.map(([key]) => `export declare const ${validatorNameFor(key)}: RuntimeContractValidator;`);
const runtimeTypes = [
  'export interface RuntimeContractIssue { instancePath: string; keyword: string; message?: string; params: Record<string, unknown> }',
  'export interface RuntimeContractValidator { (data: unknown): boolean; errors?: RuntimeContractIssue[] | null }',
  ...runtimeExports,
].join('\n');
await writeFile(resolve(generatedDir, 'validators.runtime.d.ts'), `/* Generated from docs/contracts/v1.schema.json. Do not edit. */\n\n${runtimeTypes}\n`);

const validatorExports: string[] = [
  '/* Generated from docs/contracts/v1.schema.json. Do not edit. */',
  "import * as generated from './validators.runtime.js';",
  "import type * as types from './types.js';",
  "import type { RuntimeContractValidator } from './validators.runtime.js';",
  "import type { ContractName } from '../validation.js';",
  '',
  'export const generatedValidators: Record<ContractName, RuntimeContractValidator> = {',
];
for (const [key] of defs) validatorExports.push(`  ${JSON.stringify(key)}: generated.${validatorNameFor(key)},`);
validatorExports.push('};');
for (const [key] of defs) {
  const typeName = nameFor(key);
  validatorExports.push(`export const ${validatorNameFor(key)} = (value: unknown): value is types.${typeName} => generated.${validatorNameFor(key)}(value);`);
}
validatorExports.push('export const validateBoard = validateBoardDocument;');
validatorExports.push('export const validateCard = validateCanvasCard;');
validatorExports.push('');
await writeFile(resolve(generatedDir, 'validators.ts'), `${validatorExports.join('\n')}\n`);
await copyFile(canonicalSchemaPath, resolve(generatedDir, 'v1.schema.json'));
