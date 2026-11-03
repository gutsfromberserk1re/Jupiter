/**
 * Persistent 2D skeletal skin weights.
 *
 * Weights live on a normalized grid, not in source-pixel coordinates, so they
 * survive changes to an imported image's resolution. Every stored vertex has
 * zero or more non-negative influences whose sum is 1 when the vertex is
 * influenced.
 */
export const SKIN_GRID = 24;
export const SKIN_FORMAT_VERSION = 1;
const validatedRigVersions = new WeakMap();

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : 0));
const gridKey = (x, y) => `${x},${y}`;
const validGridKey = key => {
  const match = /^(\d+),(\d+)$/.exec(key);
  if (!match) return false;
  const x = Number(match[1]), y = Number(match[2]);
  return x >= 0 && y >= 0 && x <= SKIN_GRID && y <= SKIN_GRID;
};

export function normalizeWeights(weights, boneIds = null) {
  const allowed = boneIds ? new Set(boneIds) : null;
  const cleaned = {};
  for (const [id, raw] of Object.entries(weights || {})) {
    const value = Number(raw);
    if ((!allowed || allowed.has(id)) && Number.isFinite(value) && value > 0) cleaned[id] = value;
  }
  const total = Object.values(cleaned).reduce((sum, value) => sum + value, 0);
  if (total <= 1e-8) return {};
  for (const id of Object.keys(cleaned)) cleaned[id] /= total;
  return cleaned;
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 1e-8
    ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq)
    : 0;
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

export function autoWeights(rig, resolution = SKIN_GRID) {
  if (!rig?.nodes?.length || !rig?.bones?.length) return {};
  const nodes = new Map(rig.nodes.map(node => [node.id, node]));
  const bones = rig.bones
    .map(bone => ({ bone, start: nodes.get(bone.from), end: nodes.get(bone.to) }))
    .filter(item => item.start && item.end);
  if (!bones.length) return {};

  const steps = Math.max(2, Math.min(64, Math.round(Number(resolution) || SKIN_GRID)));
  const result = {};
  const sigma = 0.18;
  for (let y = 0; y <= steps; y++) {
    for (let x = 0; x <= steps; x++) {
      const point = { x: x / steps, y: y / steps };
      // Keep the four strongest influences to bound per-vertex render work.
      const candidates = bones.map(({ bone, start, end }) => {
        const distance = distanceToSegment(point, start, end);
        return [bone.id, Math.exp(-(distance * distance) / (2 * sigma * sigma))];
      }).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const total = candidates.reduce((sum, item) => sum + item[1], 0);
      result[gridKey(x, y)] = total > 1e-8
        ? Object.fromEntries(candidates.map(([id, weight]) => [id, weight / total]))
        : {};
    }
  }
  return result;
}

export function weightsAt(rig, u, v, resolution = SKIN_GRID) {
  const steps = Math.max(2, Math.min(64, Math.round(Number(resolution) || SKIN_GRID)));
  const gx = clamp(u) * steps, gy = clamp(v) * steps;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const x1 = Math.min(steps, x0 + 1), y1 = Math.min(steps, y0 + 1);
  const tx = gx - x0, ty = gy - y0;
  const result = {};
  const samples = [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty],
  ];
  for (const [x, y, factor] of samples) {
    if (factor <= 0) continue;
    const weights = rig?.weights?.[gridKey(x, y)] || {};
    for (const [id, value] of Object.entries(weights)) result[id] = (result[id] || 0) + value * factor;
  }
  return normalizeWeights(result, (rig?.bones || []).map(bone => bone.id));
}

/** Paint in normalized artwork coordinates. aspectY is imageHeight/imageWidth,
 * which keeps the brush circular in screen pixels for portrait and landscape art. */
export function paintWeights(rig, point, boneId, options = {}) {
  if (!rig || !boneId || !(rig.bones || []).some(bone => bone.id === boneId)) return 0;
  ensureWeights(rig);
  const radius = Math.max(0.005, Number(options.radius) || 0.09);
  const strength = clamp(options.strength ?? 0.35);
  const mode = ['add', 'subtract', 'smooth'].includes(options.mode) ? options.mode : 'add';
  const aspectY = Math.max(0.05, Math.min(20, Number(options.aspectY) || 1));
  const centerX = clamp(point?.x), centerY = clamp(point?.y);
  const ids = (rig.bones || []).map(bone => bone.id);
  const original = rig.weights;
  // Smooth reads exclusively from this snapshot. It therefore does not depend
  // on whether the brush loop traverses left-to-right or right-to-left.
  const source = mode === 'smooth'
    ? Object.fromEntries(Object.entries(original).map(([key, weights]) => [key, { ...weights }]))
    : original;

  let touched = 0;
  for (let y = 0; y <= SKIN_GRID; y++) {
    for (let x = 0; x <= SKIN_GRID; x++) {
      const dx = x / SKIN_GRID - centerX;
      const dy = (y / SKIN_GRID - centerY) * aspectY;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;

      const falloff = 1 - distance / radius;
      const influence = clamp(strength * falloff);
      const key = gridKey(x, y);
      const current = { ...(source[key] || {}) };
      if (mode === 'subtract') {
        current[boneId] = Math.max(0, (current[boneId] || 0) - influence);
      } else if (mode === 'smooth') {
        const neighbours = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
          .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx <= SKIN_GRID && ny <= SKIN_GRID)
          .map(([nx, ny]) => source[gridKey(nx, ny)] || {});
        const averaged = {};
        for (const id of ids) {
          averaged[id] = neighbours.reduce((sum, weights) => sum + (weights[id] || 0), 0) / Math.max(1, neighbours.length);
        }
        for (const id of ids) current[id] = (current[id] || 0) * (1 - influence) + averaged[id] * influence;
      } else {
        current[boneId] = (current[boneId] || 0) + (1 - (current[boneId] || 0)) * influence;
      }
      rig.weights[key] = normalizeWeights(current, ids);
      touched++;
    }
  }
  if (touched) {
    rig.weightsRevision = (Number(rig.weightsRevision) || 0) + 1;
    rig.skinFormatVersion = SKIN_FORMAT_VERSION;
    validatedRigVersions.set(rig, rig.weightsRevision);
  }
  return touched;
}

/** Validate legacy/project data without undoing intentionally empty vertices. */
export function ensureWeights(rig) {
  if (!rig || !rig.bones?.length) return false;
  const currentRevision = Number(rig.weightsRevision) || 0;
  const hasCompleteGrid = rig.weights && typeof rig.weights === 'object' && Object.keys(rig.weights).length === (SKIN_GRID + 1) ** 2;
  if (hasCompleteGrid && rig.skinFormatVersion === SKIN_FORMAT_VERSION && validatedRigVersions.get(rig) === currentRevision) return false;
  const ids = rig.bones.map(bone => bone.id);
  let changed = false;
  if (!rig.weights || typeof rig.weights !== 'object' || !Object.keys(rig.weights).some(validGridKey)) {
    rig.weights = autoWeights(rig);
    changed = true;
  } else {
    for (const key of Object.keys(rig.weights)) {
      if (!validGridKey(key)) {
        delete rig.weights[key];
        changed = true;
        continue;
      }
      const before = JSON.stringify(rig.weights[key] || {});
      const normalized = normalizeWeights(rig.weights[key], ids);
      if (JSON.stringify(normalized) !== before) changed = true;
      rig.weights[key] = normalized;
    }
    // Fill missing cells in partially written/corrupt projects, but preserve
    // valid empty cells (which are useful for deliberately removing influence).
    const generated = autoWeights(rig);
    for (let y = 0; y <= SKIN_GRID; y++) {
      for (let x = 0; x <= SKIN_GRID; x++) {
        const key = gridKey(x, y);
        if (!(key in rig.weights)) {
          rig.weights[key] = generated[key] || {};
          changed = true;
        }
      }
    }
  }
  rig.skinFormatVersion = SKIN_FORMAT_VERSION;
  if (changed) rig.weightsRevision = currentRevision + 1;
  else rig.weightsRevision = currentRevision;
  validatedRigVersions.set(rig, rig.weightsRevision);
  return changed;
}
