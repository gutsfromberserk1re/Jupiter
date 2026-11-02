import test from 'node:test';
import assert from 'node:assert/strict';
import {
  app, createProject, addClip, clipStartFrame, findTrack, getActiveClip,
} from '../src/modules/state.js';
import {
  createBone, evaluateNode, setNodePose,
} from '../src/modules/rig.js';

function freshProject() {
  app.project = createProject('Test');
  app.history.length = 0; app.future.length = 0; app.dirty = false;
  app.renderToolbar = () => {};
  app.renderAll = () => {};
  return app.project;
}

test('joint poses interpolate linearly between keyframes', () => {
  const node = { id: 'joint', x: .2, y: .2, keys: [
    { frame: 10, x: .4, y: .2 },
    { frame: 20, x: .8, y: .6 },
  ] };
  assert.deepEqual(evaluateNode(node, 0), { x: .2, y: .2 });
  const middle = evaluateNode(node, 15);
  assert.ok(Math.abs(middle.x - .6) < 1e-8);
  assert.ok(Math.abs(middle.y - .4) < 1e-8);
  assert.deepEqual(evaluateNode(node, 30), { x: .8, y: .6 });
});

test('joint edits create or update a key on the clip-local frame', () => {
  const clip = { rig: { nodes: [{ id: 'joint', x: .2, y: .3, keys: [] }], bones: [] } };
  setNodePose(clip, 'joint', { x: .65, y: .7 }, 37, 20);
  assert.deepEqual(clip.rig.nodes[0].keys, [{ frame: 17, x: .65, y: .7, interpolation: 'linear' }]);
  setNodePose(clip, 'joint', { x: .7, y: .75 }, 37, 20);
  assert.equal(clip.rig.nodes[0].keys.length, 1);
  assert.equal(clip.rig.nodes[0].keys[0].x, .7);
});

test('rig bones reject duplicate and cyclic connections', () => {
  const clip = { rig: { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], bones: [] } };
  assert.ok(createBone(clip, 'a', 'b'));
  assert.ok(createBone(clip, 'b', 'c'));
  assert.equal(createBone(clip, 'a', 'b'), null);
  assert.equal(createBone(clip, 'c', 'a'), null);
  assert.equal(clip.rig.bones.length, 2);
});

test('timeline clips are contiguous and playhead resolves the active image', () => {
  const project = freshProject();
  project.assets.push(
    { id: 'one', name: 'one.png', type: 'image', dataUrl: 'data:image/png;base64,AA==' },
    { id: 'two', name: 'two.png', type: 'image', dataUrl: 'data:image/png;base64,AA==' },
  );
  const first = addClip('one');
  const second = addClip('two');
  assert.equal(clipStartFrame(first.id), 0);
  assert.equal(clipStartFrame(second.id), first.durationFrames);
  assert.equal(findTrack(second.trackId).clipIds.length, 2);
  project.currentFrame = first.durationFrames + 1;
  assert.equal(getActiveClip().clip.id, second.id);
});

test('artwork transforms interpolate between keyframes and retain base values', async () => {
  const { evaluateClipTransform } = await import('../src/modules/rig.js');
  const clip = { transform: {
    x: 10, y: 20, scale: 1, rotation: 0, opacity: 1,
    keys: { x: [{ frame: 10, value: 30 }, { frame: 20, value: 50 }], y: [], scale: [], rotation: [], opacity: [] },
  } };
  assert.equal(evaluateClipTransform(clip, 0).x, 10);
  assert.equal(evaluateClipTransform(clip, 15).x, 40);
  assert.equal(evaluateClipTransform(clip, 30).x, 50);
  assert.equal(evaluateClipTransform(clip, 15).y, 20);
});

test('artwork transform edits upsert frame-local keys for auto keying', async () => {
  const { setClipTransformValue, evaluateClipTransform } = await import('../src/modules/rig.js');
  const clip = { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, keys: {} } };
  setClipTransformValue(clip, 'rotation', 45, 42, 12);
  assert.deepEqual(clip.transform.keys.rotation, [{ frame: 30, value: 45, interpolation: 'linear' }]);
  setClipTransformValue(clip, 'rotation', 90, 42, 12);
  assert.equal(clip.transform.keys.rotation.length, 1);
  assert.equal(evaluateClipTransform(clip, 30).rotation, 90);
});
