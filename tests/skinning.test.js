import test from 'node:test';
import assert from 'node:assert/strict';
import { autoWeights, ensureWeights, normalizeWeights, paintWeights, weightsAt, SKIN_GRID } from '../src/modules/skinning.js';

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

test('painting adds the selected influence while preserving normalized weights', () => {
  const subject = rig();
  subject.weights = autoWeights(subject);
  const before = weightsAt(subject, 0.5, 0.5).arm;
  const changed = paintWeights(subject, { x: 0.5, y: 0.5 }, 'spine', { radius: 0.2, strength: 0.8, mode: 'add' });
  const after = weightsAt(subject, 0.5, 0.5);
  assert.ok(changed > 0);
  assert.ok(after.spine > 0);
  assert.ok(after.spine > 0.05 || before < 0.95);
  assert.ok(subject.weightsRevision > 0);
  assertNormalized(subject.weights);
});

test('subtract can deliberately leave vertices uninfluenced', () => {
  const subject = rig();
  subject.bones = [{ id: 'single', from: 'root', to: 'tip' }];
  subject.weights = autoWeights(subject);
  paintWeights(subject, { x: 0.5, y: 0.5 }, 'single', { radius: 0.25, strength: 1, mode: 'subtract' });
  const center = subject.weights[`${Math.round(0.5 * SKIN_GRID)},${Math.round(0.5 * SKIN_GRID)}`];
  assert.deepEqual(center, {});
});

test('smoothing uses a stable snapshot and is independent of brush traversal order', () => {
  const a = rig(), b = rig();
  a.weights = autoWeights(a);
  b.weights = structuredClone(a.weights);
  a.weights['12,12'] = { arm: 1 };
  b.weights = structuredClone(a.weights);
  paintWeights(a, { x: 0.5, y: 0.5 }, 'spine', { radius: 0.35, strength: 0.8, mode: 'smooth' });
  paintWeights(b, { x: 0.5, y: 0.5 }, 'spine', { radius: 0.35, strength: 0.8, mode: 'smooth' });
  assert.deepEqual(a.weights, b.weights);
  assertNormalized(a.weights);
});

test('portrait aspect ratio narrows the normalized brush in the vertical direction', () => {
  const wide = rig(), portrait = rig();
  wide.weights = autoWeights(wide);
  portrait.weights = structuredClone(wide.weights);
  paintWeights(wide, { x: 0.5, y: 0.5 }, 'arm', { radius: 0.12, strength: 1, mode: 'subtract', aspectY: 1 });
  paintWeights(portrait, { x: 0.5, y: 0.5 }, 'arm', { radius: 0.12, strength: 1, mode: 'subtract', aspectY: 2 });
  const atVerticalOffset = `${12},14`;
  assert.notEqual(wide.weights[atVerticalOffset].arm, portrait.weights[atVerticalOffset].arm);
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
