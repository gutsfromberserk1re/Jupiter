import { app, ensureRig, makeId, pushUndo, getActiveClip } from './state.js';

export function nearestNode(rig, point, threshold) {
  let nearest = null;
  let best = threshold;
  for (const node of rig.nodes) {
    const distance = Math.hypot(point.x - node.x, point.y - node.y);
    if (distance < best) { best = distance; nearest = node; }
  }
  return nearest;
}

function interpolationValue(a, b, t) {
  const mode = a?.interpolation || 'linear';
  if (mode === 'hold' || mode === 'step') return t < 1 ? 0 : 1;
  if (mode === 'ease') return t * t * (3 - 2 * t);
  return t;
}

export function evaluateNode(node, frame) {
  const keys = [...(node.keys || [])].sort((a, b) => a.frame - b.frame);
  if (!keys.length) return { x: node.x, y: node.y };
  const base = { frame: 0, x: node.x, y: node.y, interpolation: 'linear' };
  const all = keys.some(key => key.frame === 0) ? keys : [base, ...keys];
  if (frame <= all[0].frame) return { x: all[0].x, y: all[0].y };
  if (frame >= all[all.length - 1].frame) return { x: all[all.length - 1].x, y: all[all.length - 1].y };
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i], b = all[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      const raw = (frame - a.frame) / Math.max(1, b.frame - a.frame);
      const t = interpolationValue(a, b, raw);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return { x: node.x, y: node.y };
}

export function evaluatedRig(clip, frame) {
  if (!clip?.rig) return null;
  const poses = new Map();
  for (const node of clip.rig.nodes) poses.set(node.id, evaluateNode(node, frame));
  return poses;
}

export function setNodePose(clip, nodeId, position, globalFrame, startFrame = 0) {
  const node = clip?.rig?.nodes.find(item => item.id === nodeId);
  if (!node) return;
  let frame = Math.round(globalFrame - startFrame + (Number(clip.sourceOffsetFrames) || 0));
  const loop = Math.max(0, Number(clip.loopDurationFrames) || 0);
  frame = loop ? ((frame % loop) + loop) % loop : Math.max(0, frame);
  node.keys ??= [];
  const existing = node.keys.find(key => key.frame === frame);
  if (existing) { existing.x = position.x; existing.y = position.y; }
  else node.keys.push({ frame, x: position.x, y: position.y, interpolation: 'linear' });
  node.keys.sort((a, b) => a.frame - b.frame);
}

export function createNode(clip, position, parentId = null) {
  const rig = ensureRig(clip);
  const node = { id: makeId('node'), name: `Joint ${rig.nodes.length + 1}`, x: position.x, y: position.y, keys: [] };
  rig.nodes.push(node);
  if (parentId) { rig.bones.push({ id: makeId('bone'), from: parentId, to: node.id }); delete rig.weights; }
  return node;
}

export function createBone(clip, fromId, toId) {
  const rig = ensureRig(clip);
  if (!fromId || !toId || fromId === toId) return null;
  if (rig.bones.some(bone => bone.from === fromId && bone.to === toId)) return null;
  // Keep the rig a directed acyclic hierarchy: a child cannot parent an ancestor.
  const hasPath = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return rig.bones.filter(b => b.from === from).some(b => hasPath(b.to, target, seen));
  };
  if (hasPath(toId, fromId)) return null;
  const bone = { id: makeId('bone'), from: fromId, to: toId };
  rig.bones.push(bone);
  delete rig.weights; // topology changed: regenerate automatic influences for the new bone
  return bone;
}

export function deleteNode(clip, nodeId) {
  if (!clip?.rig) return;
  clip.rig.nodes = clip.rig.nodes.filter(node => node.id !== nodeId);
  clip.rig.bones = clip.rig.bones.filter(bone => bone.from !== nodeId && bone.to !== nodeId);
  delete clip.rig.weights;
  if (app.project.selectedNodeId === nodeId) app.project.selectedNodeId = null;
}

export function resetNodeRestPose(clip, nodeId, position) {
  const node = clip?.rig?.nodes.find(item => item.id === nodeId);
  if (!node) return;
  node.x = position.x;
  node.y = position.y;
}

export function setNodeName(clip, nodeId, name) {
  const node = clip?.rig?.nodes.find(item => item.id === nodeId);
  if (node) node.name = name;
}


export const TRANSFORM_PROPERTIES = ['x', 'y', 'scale', 'rotation', 'opacity'];

export function evaluateClipTransform(clip, frame) {
  const source = clip?.transform || {};
  const result = {
    x: Number(source.x) || 0,
    y: Number(source.y) || 0,
    scale: Number(source.scale) || 1,
    rotation: Number(source.rotation) || 0,
    opacity: Number.isFinite(Number(source.opacity)) ? Number(source.opacity) : 1,
  };
  for (const property of TRANSFORM_PROPERTIES) {
    const keys = [...(source.keys?.[property] || [])].sort((a, b) => a.frame - b.frame);
    if (!keys.length) continue;
    const base = { frame: 0, value: result[property] };
    const all = keys.some(key => key.frame === 0) ? keys : [base, ...keys];
    if (frame <= all[0].frame) result[property] = all[0].value;
    else if (frame >= all[all.length - 1].frame) result[property] = all[all.length - 1].value;
    else {
      for (let i = 0; i < all.length - 1; i++) {
        const a = all[i], b = all[i + 1];
        if (frame >= a.frame && frame <= b.frame) {
          const raw = (frame - a.frame) / Math.max(1, b.frame - a.frame);
          const t = interpolationValue(a, b, raw);
          result[property] = a.value + (b.value - a.value) * t;
          break;
        }
      }
    }
  }
  return result;
}

export function setClipTransformValue(clip, property, value, globalFrame, startFrame = 0) {
  if (!TRANSFORM_PROPERTIES.includes(property)) return;
  clip.transform ??= { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  clip.transform.keys ??= {};
  clip.transform.keys[property] ??= [];
  let frame = Math.round(globalFrame - startFrame + (Number(clip.sourceOffsetFrames) || 0));
  const loop = Math.max(0, Number(clip.loopDurationFrames) || 0);
  frame = loop ? ((frame % loop) + loop) % loop : Math.max(0, frame);
  const existing = clip.transform.keys[property].find(key => key.frame === frame);
  if (existing) existing.value = value;
  else clip.transform.keys[property].push({ frame, value, interpolation: 'linear' });
  clip.transform.keys[property].sort((a, b) => a.frame - b.frame);
  if (frame === 0) clip.transform[property] = value;
}
