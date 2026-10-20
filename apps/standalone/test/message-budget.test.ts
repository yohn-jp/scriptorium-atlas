import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializedMessageBytes } from '../src/message-budget.js';

test('structured-clone values that cannot cross the JSON contract fail closed', () => {
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  for (const value of [cyclic, { payload: 1n }, undefined]) assert.equal(serializedMessageBytes(value), Infinity);
  assert.equal(serializedMessageBytes({ text: '日本語' }), new TextEncoder().encode('{"text":"日本語"}').byteLength);
});
