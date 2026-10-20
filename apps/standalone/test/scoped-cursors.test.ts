import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScopedCursors } from '../src/scoped-cursors.js';

test('inventory cursor tokens hide paths and bind query, revision, grant and frame', () => {
  const cursors = new ScopedCursors();
  const scope = JSON.stringify(['list', 'revision', false, 'bible/']);
  const path = 'bible%2Fprivate.yaml';
  const token = cursors.encode(path, scope)!;
  assert.ok(!token.includes('bible') && !token.includes('private'));
  assert.equal(cursors.decode(token, scope), path);
  for (const other of [
    ['snapshot', 'revision', false, 'bible/'], ['list', 'new-revision', false, 'bible/'],
    ['list', 'revision', true, 'bible/'], ['list', 'revision', false, 'notes/'],
  ]) assert.throws(() => cursors.decode(token, JSON.stringify(other)), /INVALID_INPUT/);
  assert.throws(() => new ScopedCursors().decode(token, scope), /INVALID_INPUT/);
  assert.throws(() => cursors.decode(path, scope), /INVALID_INPUT/);
  assert.equal(cursors.decode(undefined, scope), undefined);
  assert.equal(cursors.encode(null, scope), null);
});

test('frame cursor storage stays bounded and expired tokens fail explicitly', () => {
  const cursors = new ScopedCursors(2);
  const first = cursors.encode('first', 'scope')!;
  const second = cursors.encode('second', 'scope')!;
  cursors.encode('third', 'scope');
  assert.throws(() => cursors.decode(first, 'scope'), /expired/);
  assert.equal(cursors.decode(second, 'scope'), 'second');
});
