import { app, findAsset, findClip, getActiveClip, getActiveClips, pushUndo, ensureRig } from './state.js';
import { nearestNode, evaluateNode, evaluateClipTransform, setNodePose, setClipTransformValue, createNode, createBone } from './rig.js';
import { SKIN_GRID, autoWeights, weightsAt, paintWeights, ensureWeights } from './skinning.js';

const canvas = document.getElementById('stage-canvas');
const ctx = canvas.getContext('2d', { alpha: true });
let cssWidth = 1, cssHeight = 1, dpr = 1, dirty = true, drawScheduled = false, pointerState = null, brushCursor = null;
const meshBuffers = new Map();
const weightHeatmaps = new Map();

function requestDraw() {
  dirty = true;
  if (!drawScheduled) {
    drawScheduled = true;
    requestAnimationFrame(() => { drawScheduled = false; draw(); });
  }
}
function resize() {
  const rect = canvas.getBoundingClientRect();
  cssWidth = Math.max(1, rect.width); cssHeight = Math.max(1, rect.height);
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssWidth * dpr); canvas.height = Math.round(cssHeight * dpr);
  requestDraw();
}
new ResizeObserver(resize).observe(canvas);

export function loadImageAsset(asset) {
  if (!asset || asset.type !== 'image') return Promise.resolve(null);
  if (app.imageCache.has(asset.id)) return Promise.resolve(app.imageCache.get(asset.id));
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => { app.imageCache.set(asset.id, image); requestDraw(); resolve(image); };
    image.onerror = () => resolve(null);
    image.src = asset.dataUrl;
  });
}

function activeImageContexts() {
  return getActiveClips().filter(item => item.asset?.type === 'image').map(item => {
    const image = app.imageCache.get(item.asset.id);
    if (!image?.complete || !image.naturalWidth) return null;
    return { ...item, image, transform: evaluateClipTransform(item.clip, item.localFrame) };
  }).filter(Boolean);
}

function activeImageContext() {
  const contexts = activeImageContexts();
  return contexts.find(item => item.clip.id === app.project.selectedClipId) || contexts[contexts.length - 1] || null;
}

function fitScale(image) {
  const base = Math.min((cssWidth - 72) / image.naturalWidth, (cssHeight - 72) / image.naturalHeight);
  return Math.max(.02, base * app.project.viewZoom);
}

function screenToImageRaw(point, active) {
  const { image, clip } = active;
  const fit = fitScale(image) * (active.transform?.scale ?? 1);
  const centerX = cssWidth / 2 + app.project.viewPan.x + (active.transform?.x ?? 0);
  const centerY = cssHeight / 2 + app.project.viewPan.y + (active.transform?.y ?? 0);
  const angle = -(active.transform?.rotation ?? 0) * Math.PI / 180;
  const sx = point.x - centerX, sy = point.y - centerY;
  const rx = sx * Math.cos(angle) - sy * Math.sin(angle);
  const ry = sx * Math.sin(angle) + sy * Math.cos(angle);
  return { x: (rx / fit + image.naturalWidth / 2) / image.naturalWidth, y: (ry / fit + image.naturalHeight / 2) / image.naturalHeight };
}
function screenToImage(point, active) {
  const raw = screenToImageRaw(point, active);
  return { x: Math.max(0, Math.min(1, raw.x)), y: Math.max(0, Math.min(1, raw.y)) };
}

// Rig joints may intentionally sit just beyond the artwork edge. Keep a
// generous finite range so the rig can extend outside the PNG without
// allowing a lost pointer to create an infinite coordinate.
function screenToRigPoint(point, active) {
  const raw = screenToImageRaw(point, active);
  return { x: Math.max(-0.5, Math.min(1.5, raw.x)), y: Math.max(-0.5, Math.min(1.5, raw.y)) };
}
function pointIsOnImage(point, active) {
  const raw = screenToImageRaw(point, active);
  return raw.x >= 0 && raw.x <= 1 && raw.y >= 0 && raw.y <= 1;
}

function nodeScreenPoint(node, active, poses) {
  const { image, clip } = active;
  const pose = poses.get(node.id) ?? { x: node.x, y: node.y };
  const fit = fitScale(image) * (active.transform?.scale ?? 1);
  const x = (pose.x - .5) * image.naturalWidth;
  const y = (pose.y - .5) * image.naturalHeight;
  const angle = (active.transform?.rotation ?? 0) * Math.PI / 180;
  const rx = x * Math.cos(angle) - y * Math.sin(angle);
  const ry = x * Math.sin(angle) + y * Math.cos(angle);
  return { x: cssWidth / 2 + app.project.viewPan.x + (active.transform?.x ?? 0) + rx * fit, y: cssHeight / 2 + app.project.viewPan.y + (active.transform?.y ?? 0) + ry * fit };
}

function nearestRigNode(point, active, radius = 15) {
  const rig = active.clip.rig;
  if (!rig?.nodes?.length) return null;
  const poses = new Map(rig.nodes.map(node => [node.id, evaluateNode(node, active.localFrame)]));
  let picked = null, best = radius;
  for (const node of rig.nodes) {
    const p = nodeScreenPoint(node, active, poses);
    const distance = Math.hypot(point.x - p.x, point.y - p.y);
    if (distance < best) { best = distance; picked = node; }
  }
  return picked;
}

function pointSegmentDistance(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq > 1e-8 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq)) : 0;
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

function mapPointByBone(point, restA, restB, poseA, poseB) {
  const rx = restB.x - restA.x, ry = restB.y - restA.y;
  const restLength = Math.hypot(rx, ry);
  if (restLength < 1e-5) return point;
  const ux = rx / restLength, uy = ry / restLength;
  const dx = point.x - restA.x, dy = point.y - restA.y;
  const along = dx * ux + dy * uy;
  const across = -dx * uy + dy * ux;
  const px = poseB.x - poseA.x, py = poseB.y - poseA.y;
  const poseLength = Math.hypot(px, py);
  if (poseLength < 1e-5) return poseA;
  const vx = px / poseLength, vy = py / poseLength;
  return { x: poseA.x + vx * (along * poseLength / restLength) - vy * across, y: poseA.y + vy * (along * poseLength / restLength) + vx * across };
}

function skinPoint(point, rig, poses, segments) {
  if (!segments.length) return point;
  const weights = weightsAt(rig, point.x, point.y, SKIN_GRID);
  let total = 0, x = 0, y = 0;
  for (const segment of segments) {
    const weight = weights[segment.id] || 0;
    if (weight <= 1e-5) continue;
    const mapped = mapPointByBone(point, segment.start, segment.end, poses.get(segment.start.id) ?? segment.start, poses.get(segment.end.id) ?? segment.end);
    x += mapped.x * weight; y += mapped.y * weight; total += weight;
  }
  if (total < 1e-5) return point;
  return { x: x / total, y: y / total };
}

function affineTriangle(target, src, dst) {
  const [p0, p1, p2] = src, [q0, q1, q2] = dst;
  const sx1 = p1.x - p0.x, sy1 = p1.y - p0.y;
  const sx2 = p2.x - p0.x, sy2 = p2.y - p0.y;
  const det = sx1 * sy2 - sx2 * sy1;
  if (Math.abs(det) < 1e-8) return;
  const dx1 = q1.x - q0.x, dy1 = q1.y - q0.y;
  const dx2 = q2.x - q0.x, dy2 = q2.y - q0.y;
  const a = (dx1 * sy2 - dx2 * sy1) / det;
  const c = (-dx1 * sx2 + dx2 * sx1) / det;
  const b = (dy1 * sy2 - dy2 * sy1) / det;
  const d = (-dy1 * sx2 + dy2 * sx1) / det;
  const e = q0.x - a * p0.x - c * p0.y;
  const f = q0.y - b * p0.x - d * p0.y;
  target.setTransform(a, b, c, d, e, f);
}

function renderDeformedImage(image, rig, poses, clipId) {
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  if (!rig?.bones?.length || !rig.nodes?.length || !imageWidth || !imageHeight) return image;

  ensureWeights(rig);
  const topologySignature = rig.bones.map(bone => `${bone.id}:${bone.from}>${bone.to}`).join(',');
  // Weight painting increments a revision counter; avoid serializing all 625
  // vertex records on every animation frame just to validate the render cache.
  const weightSignature = Number(rig.weightsRevision) || 0;
  const poseSignature = rig.nodes.map(node => {
    const pose = poses.get(node.id) ?? node;
    return `${pose.x.toFixed(5)},${pose.y.toFixed(5)}`;
  }).join('|');
  const signature = `${topologySignature}::${weightSignature}::${poseSignature}`;
  const restSignature = rig.nodes.map(node => `${node.x.toFixed(5)},${node.y.toFixed(5)}`).join('|');
  // Return the original bitmap while the rig is at rest. This avoids needless
  // mesh work and removes any chance of triangle seams on an untouched PNG.
  if (poseSignature === restSignature) return image;

  let cached = meshBuffers.get(clipId);
  if (cached?.signature === signature && cached.canvas.width === imageWidth && cached.canvas.height === imageHeight) {
    return cached.canvas;
  }
  if (!cached || cached.canvas.width !== imageWidth || cached.canvas.height !== imageHeight) {
    const canvas = document.createElement('canvas');
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    cached = { canvas, signature: '' };
    meshBuffers.set(clipId, cached);
  }

  const off = cached.canvas;
  const c = off.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, off.width, off.height);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  const cols = SKIN_GRID, rows = SKIN_GRID, width = imageWidth, height = imageHeight;
  const nodes = new Map(rig.nodes.map(node => [node.id, node]));
  const segments = rig.bones.map(bone => ({ id: bone.id, start: nodes.get(bone.from), end: nodes.get(bone.to) })).filter(segment => segment.start && segment.end);
  const grid = [];
  for (let y = 0; y <= rows; y++) {
    const line = [];
    for (let x = 0; x <= cols; x++) {
      const u = x / cols, v = y / rows;
      const deformed = skinPoint({ x: u, y: v }, rig, poses, segments);
      line.push({ x: deformed.x * width, y: deformed.y * height });
    }
    grid.push(line);
  }
  const drawTri = (src, dst) => {
    // Expand the clipping triangle by a fraction of a destination pixel. The
    // affine texture mapping remains exact, but adjacent triangles overlap
    // enough to suppress hairline rasterization cracks.
    const cx = (dst[0].x + dst[1].x + dst[2].x) / 3;
    const cy = (dst[0].y + dst[1].y + dst[2].y) / 3;
    const clipDst = dst.map(point => {
      const dx = point.x - cx, dy = point.y - cy;
      const length = Math.max(1e-5, Math.hypot(dx, dy));
      const overlap = 0.55;
      return { x: point.x + dx / length * overlap, y: point.y + dy / length * overlap };
    });
    c.save();
    c.beginPath();
    c.moveTo(clipDst[0].x, clipDst[0].y);
    c.lineTo(clipDst[1].x, clipDst[1].y);
    c.lineTo(clipDst[2].x, clipDst[2].y);
    c.closePath();
    c.clip();
    affineTriangle(c, src, dst);
    c.drawImage(image, 0, 0);
    c.restore();
  };
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const sx = x * width / cols, sy = y * height / rows;
    const sx1 = (x + 1) * width / cols, sy1 = (y + 1) * height / rows;
    const s00 = { x: sx, y: sy }, s10 = { x: sx1, y: sy }, s01 = { x: sx, y: sy1 }, s11 = { x: sx1, y: sy1 };
    const d00 = grid[y][x], d10 = grid[y][x + 1], d01 = grid[y + 1][x], d11 = grid[y + 1][x + 1];
    drawTri([s00, s10, s11], [d00, d10, d11]);
    drawTri([s00, s11, s01], [d00, d11, d01]);
  }
  cached.signature = signature;
  return off;
}


function buildWeightHeatmap(image, rig, boneId, clipId) {
  if (!rig?.bones?.some(bone => bone.id === boneId)) return null;
  ensureWeights(rig);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  // Keep the preview overlay light even for very large source PNGs. It is
  // drawn back over the full artwork size after its mesh deformation pass.
  const previewScale = Math.min(1, 2048 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * previewScale));
  const height = Math.max(1, Math.round(sourceHeight * previewScale));
  const revision = Number(rig.weightsRevision) || 0;
  const signature = `${boneId}:${revision}:${sourceWidth}x${sourceHeight}:${width}x${height}`;
  let cached = weightHeatmaps.get(clipId);
  if (cached?.signature === signature) return cached.canvas;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const overlay = canvas.getContext('2d');
  // Sample at 4x the skin grid and let the browser smooth the overlay when it
  // is expanded to source resolution. This avoids a chunky 24-cell heat map.
  const previewSize = SKIN_GRID * 4;
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = previewSize;
  sampleCanvas.height = previewSize;
  const sample = sampleCanvas.getContext('2d');
  for (let y = 0; y < previewSize; y++) {
    for (let x = 0; x < previewSize; x++) {
      const weight = weightsAt(rig, (x + 0.5) / previewSize, (y + 0.5) / previewSize, SKIN_GRID)[boneId] || 0;
      if (weight <= 0.015) continue;
      sample.fillStyle = `rgba(64, 137, 184, ${Math.min(0.38, weight * 0.42)})`;
      sample.fillRect(x, y, 1.2, 1.2);
    }
  }
  overlay.imageSmoothingEnabled = true;
  overlay.imageSmoothingQuality = 'high';
  overlay.drawImage(sampleCanvas, 0, 0, width, height);
  // Keep the influence wash inside the PNG's alpha silhouette.
  overlay.globalCompositeOperation = 'destination-in';
  overlay.drawImage(image, 0, 0, width, height);
  overlay.globalCompositeOperation = 'source-over';
  weightHeatmaps.set(clipId, { signature, canvas });
  if (weightHeatmaps.size > 8) weightHeatmaps.delete(weightHeatmaps.keys().next().value);
  return canvas;
}

function drawContext(active, rigTargetClipId = null) {
  const { clip, asset, image, localFrame } = active;
  const transform = active.transform;
  const fit = fitScale(image) * (transform.scale ?? 1);
  const centerX = cssWidth / 2 + app.project.viewPan.x + (transform.x ?? 0);
  const centerY = cssHeight / 2 + app.project.viewPan.y + (transform.y ?? 0);
  const rig = clip.rig;
  const poses = rig ? new Map(rig.nodes.map(node => [node.id, evaluateNode(node, localFrame)])) : new Map();
  const output = renderDeformedImage(image, rig, poses, clip.id);

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate((transform.rotation ?? 0) * Math.PI / 180);
  ctx.scale(fit, fit);
  ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity ?? 1));
  ctx.drawImage(output, -image.naturalWidth / 2, -image.naturalHeight / 2);
  ctx.globalAlpha = 1;

  const paintMode = app.project.weightPaint?.enabled && app.project.selectedClipId === clip.id;
  if (paintMode && rig?.bones?.length) {
    const boneId = app.project.weightPaint.boneId;
    const heatmap = buildWeightHeatmap(image, rig, boneId, clip.id);
    if (heatmap) {
      const deformedHeatmap = renderDeformedImage(heatmap, rig, poses, `${clip.id}:weight-preview:${boneId}`);
      ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity ?? 1));
      ctx.drawImage(deformedHeatmap, -image.naturalWidth / 2, -image.naturalHeight / 2, image.naturalWidth, image.naturalHeight);
      ctx.globalAlpha = 1;
    }
  }
  if (paintMode && rig?.bones?.length) {
    const selectedBone = rig.bones.find(b => b.id === app.project.weightPaint.boneId);
    if (selectedBone) {
      const a = rig.nodes.find(n => n.id === selectedBone.from), b = rig.nodes.find(n => n.id === selectedBone.to);
      if (a && b) {
        const pa = poses.get(a.id) ?? a, pb = poses.get(b.id) ?? b;
        // drawContext already has the artwork transform applied, so use local
        // image coordinates here instead of applying the transform a second time.
        ctx.save();
        ctx.strokeStyle = 'rgba(65,132,178,.92)'; ctx.lineWidth = 2.4 / fit; ctx.setLineDash([6 / fit, 4 / fit]);
        ctx.beginPath(); ctx.moveTo((pa.x-.5)*image.naturalWidth,(pa.y-.5)*image.naturalHeight); ctx.lineTo((pb.x-.5)*image.naturalWidth,(pb.y-.5)*image.naturalHeight); ctx.stroke();
        ctx.restore();
      }
    }
  }

  const isSelected = app.project.selectedClipId === clip.id;
  const showRig = !!rig?.nodes?.length && (isSelected || (active.clip.id === rigTargetClipId && ['rig', 'node'].includes(app.project.activeTool)));
  if (showRig) {
    const scaleFix = 1 / Math.max(.001, fit);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const bone of rig.bones) {
      const a = rig.nodes.find(node => node.id === bone.from), b = rig.nodes.find(node => node.id === bone.to);
      if (!a || !b) continue;
      const pa = poses.get(a.id) ?? a, pb = poses.get(b.id) ?? b;
      ctx.beginPath();
      ctx.moveTo((pa.x - .5) * image.naturalWidth, (pa.y - .5) * image.naturalHeight);
      ctx.lineTo((pb.x - .5) * image.naturalWidth, (pb.y - .5) * image.naturalHeight);
      ctx.strokeStyle = isSelected ? '#668ca9' : 'rgba(105,132,153,.62)';
      ctx.lineWidth = 1.65 * scaleFix;
      ctx.stroke();
    }
    for (const node of rig.nodes) {
      const pose = poses.get(node.id) ?? node;
      const x = (pose.x - .5) * image.naturalWidth, y = (pose.y - .5) * image.naturalHeight;
      const selected = isSelected && node.id === app.project.selectedNodeId;
      ctx.beginPath(); ctx.arc(x, y, (selected ? 5.4 : 4.1) * scaleFix, 0, Math.PI * 2);
      ctx.fillStyle = selected ? '#4e789b' : '#fdfefe'; ctx.fill();
      ctx.lineWidth = (selected ? 1.8 : 1.25) * scaleFix;
      ctx.strokeStyle = selected ? '#315f83' : '#8298aa'; ctx.stroke();
      if (selected) {
        ctx.beginPath(); ctx.arc(x, y, 8 * scaleFix, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(74,119,153,.48)'; ctx.lineWidth = scaleFix; ctx.stroke();
      }
    }
    if (pointerState?.type === 'draw-bone' && pointerState.clipId === clip.id) {
      const startNode = rig.nodes.find(node => node.id === pointerState.startNodeId);
      if (startNode) {
        const pose = poses.get(startNode.id) ?? startNode;
        const x = (pose.x - .5) * image.naturalWidth, y = (pose.y - .5) * image.naturalHeight;
        const endpoint = screenToRigPoint(pointerState.endpoint, active);
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.lineTo((endpoint.x - .5) * image.naturalWidth, (endpoint.y - .5) * image.naturalHeight);
        ctx.strokeStyle = '#5b87a9'; ctx.lineWidth = 1.4 * scaleFix;
        ctx.setLineDash([4 * scaleFix, 3 * scaleFix]); ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }
  ctx.restore();

  if (isSelected && ['select', 'move'].includes(app.project.activeTool)) {
    ctx.save(); ctx.translate(centerX, centerY); ctx.rotate((transform.rotation ?? 0) * Math.PI / 180); ctx.scale(fit, fit);
    ctx.strokeStyle = 'rgba(83,123,157,.68)'; ctx.lineWidth = 1 / fit;
    ctx.setLineDash([4 / fit, 3 / fit]);
    ctx.strokeRect(-image.naturalWidth / 2, -image.naturalHeight / 2, image.naturalWidth, image.naturalHeight);
    ctx.restore();
  }
}

function drawBrushCursor(active) {
  const paint = app.project.weightPaint;
  if (!paint?.enabled || app.project.activeTool !== 'node' || !active || !brushCursor || brushCursor.clipId !== active.clip.id || app.project.selectedClipId !== active.clip.id) return;
  const fit = fitScale(active.image) * (active.transform?.scale ?? 1);
  const radius = Math.max(0.005, Number(paint.radius) || 0.09);
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(brushCursor.point.x, brushCursor.point.y, radius * active.image.naturalWidth * fit, radius * active.image.naturalHeight * fit, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(83,139,178,.08)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(54,111,151,.9)';
  ctx.lineWidth = 1.25;
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.restore();
}

function draw() {
  if (!dirty) return;
  dirty = false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  const contexts = activeImageContexts();
  const empty = document.getElementById('stage-empty');
  empty.classList.toggle('hidden', contexts.length > 0);
  if (!contexts.length) {
    document.getElementById('canvas-info').textContent = 'TRANSPARENT CANVAS';
    return;
  }
  // Draw V1 first and V3 last, so upper video layers composite over lower ones.
  const selected = contexts.find(item => item.clip.id === app.project.selectedClipId) || contexts[contexts.length - 1];
  const rigTargetClipId = selected?.clip.id ?? null;
  for (const active of contexts) drawContext(active, rigTargetClipId);
  drawBrushCursor(selected);
  document.getElementById('canvas-info').textContent = `${contexts.length} visible layer${contexts.length === 1 ? '' : 's'} · ${selected.asset.name} · ${selected.image.naturalWidth} × ${selected.image.naturalHeight}`;
}

function stagePoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function onPointerDown(event) {
  if (event.button !== 0 && event.button !== 1) return;
  const point = stagePoint(event);

  if (event.button === 1 || event.altKey) {
    canvas.setPointerCapture(event.pointerId);
    pointerState = { type: 'pan', point, pan: { ...app.project.viewPan } };
    return;
  }

  // Pick from the visually topmost active image first. Node handles are tested
  // before image bounds so an endpoint just outside a PNG remains selectable.
  const contexts = activeImageContexts().slice().reverse();
  let active = null, hit = null, onImage = false;
  for (const context of contexts) {
    const candidate = nearestRigNode(point, context, 18);
    const inside = pointIsOnImage(point, context);
    if (candidate || inside) { active = context; hit = candidate; onImage = inside; break; }
  }
  if (!active) {
    if (app.project.activeTool === 'select') {
      app.project.selectedClipId = null; app.project.selectedAssetId = null; app.project.selectedNodeId = null;
      app.project.inspectorTab = 'values'; app.renderAll();
    }
    return;
  }

  const tool = app.project.activeTool;
  canvas.setPointerCapture(event.pointerId);

  // Weight painting edits persistent per-vertex bone influences, never the artwork pixels.
  if (app.project.weightPaint?.enabled && tool === 'node' && onImage) {
    const rig = ensureRig(active.clip);
    if (!rig.bones.length) { toast('Create at least one bone before painting weights.'); return; }
    if (!rig.bones.some(bone => bone.id === app.project.weightPaint.boneId)) app.project.weightPaint.boneId = rig.bones[0].id;
    if (!rig.weights || !Object.keys(rig.weights).length) rig.weights = autoWeights(rig);
    pushUndo('Paint bone weights');
    app.project.selectedClipId = active.clip.id;
    app.project.selectedAssetId = active.asset.id;
    pointerState = { type: 'paint-weights', pointerId: event.pointerId, clipId: active.clip.id };
    brushCursor = { clipId: active.clip.id, point };
    paintWeights(rig, screenToImage(point, active), app.project.weightPaint.boneId, { ...app.project.weightPaint, aspectY: active.image.naturalHeight / active.image.naturalWidth });
    requestDraw(); return;
  }

  // Node edits rig joints only. It deliberately does not require the pointer
  // to be inside the PNG bounds, since rig endpoints may sit just outside it.
  if (tool === 'node') {
    if (!hit) return;
    pushUndo('Pose joint');
    app.project.selectedClipId = active.clip.id;
    app.project.selectedAssetId = active.asset.id;
    app.project.selectedNodeId = hit.id;
    app.project.inspectorTab = 'values';
    pointerState = { type: 'move-node', pointerId: event.pointerId, nodeId: hit.id, clipId: active.clip.id, startFrame: active.startFrame };
    app.renderInspector(); requestDraw(); return;
  }

  // Move transforms the selected artwork layer only; it never edits rig nodes.
  if (tool === 'move') {
    if (!onImage) return;
    app.project.selectedClipId = active.clip.id;
    app.project.selectedAssetId = active.asset.id;
    app.project.selectedNodeId = null;
    app.project.inspectorTab = 'values';
    pushUndo('Move artwork');
    pointerState = {
      type: 'move-layer', pointerId: event.pointerId, clipId: active.clip.id,
      startFrame: active.startFrame, origin: point,
      startX: active.transform.x ?? 0, startY: active.transform.y ?? 0,
    };
    app.renderInspector(); requestDraw(); return;
  }

  if (tool === 'rig') {
    if (!onImage && !hit) return;
    const rig = ensureRig(active.clip);
    if (!hit) {
      pushUndo('Create rig root');
      const root = createNode(active.clip, screenToImage(point, active));
      root.name = rig.nodes.length === 1 ? 'Root' : `Joint ${rig.nodes.length}`;
      app.project.selectedNodeId = root.id;
      pointerState = { type: 'draw-bone', pointerId: event.pointerId, clipId: active.clip.id, startNodeId: root.id, moved: false, shiftConnect: !!event.shiftKey, origin: point, endpoint: point };
    } else {
      pushUndo('Create bone');
      app.project.selectedNodeId = hit.id;
      pointerState = { type: 'draw-bone', pointerId: event.pointerId, clipId: active.clip.id, startNodeId: hit.id, moved: false, shiftConnect: !!event.shiftKey, origin: point, endpoint: point };
    }
    app.project.selectedClipId = active.clip.id;
    app.project.selectedAssetId = active.asset.id;
    app.project.inspectorTab = 'values';
    app.renderInspector(); requestDraw(); return;
  }

  // Select selects artwork or a joint but does not move either one.
  if (tool === 'select') {
    if (hit) {
      app.project.selectedClipId = active.clip.id;
      app.project.selectedAssetId = active.asset.id;
      app.project.selectedNodeId = hit.id;
      app.project.inspectorTab = 'values';
    } else if (onImage) {
      app.project.selectedClipId = active.clip.id;
      app.project.selectedAssetId = active.asset.id;
      app.project.selectedNodeId = null;
      app.project.inspectorTab = 'values';
    } else return;
    app.renderInspector(); app.renderTimeline(); requestDraw();
  }
}

function onPointerMove(event) {
  const point = stagePoint(event);
  if (!pointerState) {
    const active = activeImageContext();
    brushCursor = app.project.weightPaint?.enabled && app.project.activeTool === 'node' && active
      ? { clipId: active.clip.id, point } : null;
    requestDraw();
    return;
  }
  brushCursor = { clipId: pointerState.clipId, point };
  if (pointerState.type === 'pan') {
    app.project.viewPan = { x: pointerState.pan.x + point.x - pointerState.point.x, y: pointerState.pan.y + point.y - pointerState.point.y };
    requestDraw(); return;
  }
  const activeNow = activeImageContext();
  if (!activeNow || activeNow.clip.id !== pointerState.clipId) return;
  if (pointerState.type === 'paint-weights') {
    const rig = activeNow.clip.rig;
    paintWeights(rig, screenToImage(point, activeNow), app.project.weightPaint.boneId, { ...app.project.weightPaint, aspectY: activeNow.image.naturalHeight / activeNow.image.naturalWidth });
    requestDraw(); return;
  }
  if (pointerState.type === 'move-node') {
    const normalized = screenToRigPoint(point, activeNow);
    if (app.project.autoKey !== false) {
      setNodePose(activeNow.clip, pointerState.nodeId, normalized, app.project.currentFrame, pointerState.startFrame);
    } else {
      const node = activeNow.clip.rig?.nodes.find(item => item.id === pointerState.nodeId);
      if (node) { node.x = normalized.x; node.y = normalized.y; }
    }
    requestDraw(); return;
  }
  if (pointerState.type === 'move-layer') {
    const dx = point.x - pointerState.origin.x;
    const dy = point.y - pointerState.origin.y;
    if (app.project.autoKey !== false) {
      setClipTransformValue(activeNow.clip, 'x', pointerState.startX + dx, app.project.currentFrame, pointerState.startFrame);
      setClipTransformValue(activeNow.clip, 'y', pointerState.startY + dy, app.project.currentFrame, pointerState.startFrame);
    } else {
      activeNow.clip.transform.x = pointerState.startX + dx;
      activeNow.clip.transform.y = pointerState.startY + dy;
    }
    requestDraw(); return;
  }
  if (pointerState.type === 'draw-bone') {
    pointerState.endpoint = point;
    pointerState.shiftConnect ||= !!event.shiftKey;
    pointerState.moved ||= Math.hypot(point.x - pointerState.origin.x, point.y - pointerState.origin.y) > 5;
    requestDraw();
  }
}

function onPointerUp(event) {
  if (!pointerState) return;
  const state = pointerState; pointerState = null;
  if (state.type === 'draw-bone' && state.moved) {
    const active = activeImageContext();
    if (!active || active.clip.id !== state.clipId) return;
    const endPoint = stagePoint(event);
    const target = (event.shiftKey || state.shiftConnect) ? nearestRigNode(endPoint, active, 22) : null;
    if (target && target.id !== state.startNodeId) {
      const bone = createBone(active.clip, state.startNodeId, target.id);
      if (!bone) toast('That connection would create a duplicate or cycle.');
      else app.project.selectedNodeId = target.id;
    } else {
      const normalized = screenToRigPoint(endPoint, active);
      const node = createNode(active.clip, normalized, state.startNodeId);
      app.project.selectedNodeId = node.id;
    }
  }
  app.renderAll();
}

function toast(message) { window.jupiterToast?.(message); }

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('pointerleave', () => { if (!pointerState) { brushCursor = null; requestDraw(); } });
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  app.project.viewZoom = Math.max(.15, Math.min(5, app.project.viewZoom * (event.deltaY < 0 ? 1.1 : .91)));
  document.getElementById('zoom-label').textContent = `${Math.round(app.project.viewZoom * 100)}%`;
  requestDraw();
}, { passive: false });

export function setTool(tool) { app.project.activeTool = tool; app.renderToolbar(); app.renderInspector(); requestDraw(); }
export function refreshStage() { requestDraw(); }
export function renderStageNow() { draw(); }
export function getCanvasElement() { return canvas; }
export function stageResize() { resize(); }

requestDraw();
