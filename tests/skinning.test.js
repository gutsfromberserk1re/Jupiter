import test from 'node:test';
import assert from 'node:assert/strict';
import { autoWeights, ensureWeights, normalizeWeights, weightsAt, SKIN_GRID } from '../src/modules/skinning.js';

const rig = () => ({
  nodes: [
    { id: 'root', x: 0.2, y: 0.5 },
    { id: 'tip', x: 0.8, y: 0.5 },
    { id: 'other', x: 0.5, y: 0.1 },
  ],
  bones: [
    { id: 'arm', from: 'root', to: 'tip' },
    { id: 'spine', from: 'root', to: 'other' },
  ],
});

function assertNormalized(weights) {
  for (const influence of Object.values(weights)) {
    const sum = Object.values(influence).reduce((a, b) => a + b, 0);
    assert.ok(sum === 0 || Math.abs(sum - 1) < 1e-8, `expected normalized influences, got ${sum}`);
    for (const value of Object.values(influence)) assert.ok(Number.isFinite(value) && value >= 0);
  }
}

test('automatic weights populate the mesh and normalize every vertex', () => {
  const subject = rig();
  subject.weights = autoWeights(subject);
  assert.equal(Object.keys(subject.weights).length, (SKIN_GRID + 1) ** 2);
  assertNormalized(subject.weights);
});

test('weight sampling bilinearly interpolates and normalizes active influences', () => {
  const subject = rig();
  subject.weights = autoWeights(subject);
  const weights = weightsAt(subject, 0.5, 0.5);
  assert.ok(weights.arm > 0);
  assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 1e-8);
});

test('ensureWeights removes stale bone IDs, repairs missing cells, and keeps valid empty cells', () => {
  const subject = rig();
  subject.weights = { '0,0': { removedBone: 1 }, '12,12': {} };
  ensureWeights(subject);
  assert.deepEqual(subject.weights['0,0'], {});
  assert.deepEqual(subject.weights['12,12'], {});
  assert.equal(Object.keys(subject.weights).length, (SKIN_GRID + 1) ** 2);
  assertNormalized(subject.weights);
});

test('normalization drops invalid influences and handles empty weights', () => {
  assert.deepEqual(normalizeWeights({ a: 2, b: -1, c: 2 }, ['a', 'c']), { a: 0.5, c: 0.5 });
  assert.deepEqual(normalizeWeights({ a: 0 }), {});
});


test('ensureWeights regenerates after a rig topology edit invalidates its grid', () => {
  const subject = rig();
  subject.weights = autoWeights(subject);
  ensureWeights(subject);
  const revision = subject.weightsRevision;
  delete subject.weights; // createBone/deleteNode invalidate weights this way
  ensureWeights(subject);
  assert.equal(Object.keys(subject.weights).length, (SKIN_GRID + 1) ** 2);
  assert.ok(subject.weightsRevision > revision);
});
