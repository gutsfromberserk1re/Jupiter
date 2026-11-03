/**
 * Persistent 2D skeletal skin weights, generated automatically from the rig.
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
