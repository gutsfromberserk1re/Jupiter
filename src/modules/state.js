export const makeId = (prefix = 'id') => `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
export const clone = value => JSON.parse(JSON.stringify(value));

const createTrack = (type, index) => ({
  id: makeId('track'),
  name: type === 'video' ? (index === 1 ? 'Main video' : `Video ${index}`) : (index === 1 ? 'Main audio' : `Audio ${index}`),
  code: `${type === 'video' ? 'V' : 'A'}${index}`,
  type,
  clipIds: [],
});

export function createProject(name = 'Untitled Project') {
  return {
    schemaVersion: 2,
    name,
    fps: 24,
    width: 1920,
    height: 1080,
    assets: [],
    clips: [],
    // Start with only V1 and A1. Additional layers are created by dropping
    // media onto the temporary "create layer" target shown during a drag.
    tracks: [createTrack('video', 1), createTrack('audio', 1)],
    selectedAssetId: null,
    selectedClipId: null,
    selectedNodeId: null,
    activeTool: 'select',
    currentFrame: 0,
    playing: false,
    autoKey: true,
    timelineZoom: 3.2,
    viewZoom: 1,
    viewPan: { x: 0, y: 0 },
    inspectorTab: 'values',
    graphProperty: 'x',
    lastProjectPath: null,
  };
}

export const app = {
  project: createProject(),
  history: [],
  future: [],
  dirty: false,
  imageCache: new Map(),
  drawStage: () => {},
  renderTimeline: () => {},
  renderInspector: () => {},
  renderMedia: () => {},
  renderToolbar: () => {},
  renderAll: () => {},
  pointer: null,
  lastPlaybackTime: 0,
  audioPlayers: new Map(),
};

export function pushUndo(label = 'Change') {
  app.history.push({ label, snapshot: clone(app.project) });
  if (app.history.length > 80) app.history.shift();
  app.future.length = 0;
  app.dirty = true;
  app.renderToolbar();
}

export function undo() {
  const entry = app.history.pop();
  if (!entry) return false;
  app.future.push({ snapshot: clone(app.project) });
  app.project = entry.snapshot;
  app.dirty = true;
  app.renderAll();
  return true;
}

export function redo() {
  const entry = app.future.pop();
  if (!entry) return false;
  app.history.push({ label: 'Redo', snapshot: clone(app.project) });
  app.project = entry.snapshot;
  app.dirty = true;
  app.renderAll();
  return true;
}

export function findTrack(trackId) { return app.project.tracks.find(track => track.id === trackId) ?? null; }
export function findClip(clipId) { return app.project.clips.find(clip => clip.id === clipId) ?? null; }
export function findAsset(assetId) { return app.project.assets.find(asset => asset.id === assetId) ?? null; }
export function getTracks(type = null) { return app.project.tracks.filter(track => !type || track.type === type); }

export function clipStartFrame(clipId) {
  const clip = findClip(clipId);
  if (!clip) return 0;
  const track = findTrack(clip.trackId);
  if (!track) return 0;
  let cursor = 0;
  for (const id of track.clipIds) {
    const item = findClip(id);
    if (!item) continue;
    if (id === clipId) return cursor;
    cursor += Math.max(1, item.durationFrames || 1);
  }
  return 0;
}

export function getTrackDuration(track) {
  return track.clipIds.reduce((sum, id) => sum + Math.max(1, findClip(id)?.durationFrames || 1), 0);
}

export function getSequenceDuration() {
  return Math.max(1, ...app.project.tracks.map(getTrackDuration));
}

// Returns every video layer active at a frame, from V1 (back) to V3 (front).
// This is important: overlapping clips on different video layers composite
// together rather than replacing one another in the preview.
export function getActiveClips(frame = app.project.currentFrame) {
  const active = [];
  const videoTracks = getTracks('video').sort((a, b) => Number(a.code?.slice(1) || 1) - Number(b.code?.slice(1) || 1));
  for (const track of videoTracks) {
    let cursor = 0;
    for (const clipId of track.clipIds) {
      const clip = findClip(clipId);
      if (!clip) continue;
      const duration = Math.max(1, clip.durationFrames || 1);
      if (frame >= cursor && frame < cursor + duration) {
        active.push({ clip, asset: findAsset(clip.assetId), startFrame: cursor, localFrame: frame - cursor, track });
        break;
      }
      cursor += duration;
    }
  }
  return active;
}

export function getActiveClip(frame = app.project.currentFrame) {
  const active = getActiveClips(frame);
  return active[active.length - 1] ?? null;
}

export function ensureRig(clip) {
  if (!clip.rig) clip.rig = { nodes: [], bones: [] };
  if (!clip.rig.nodes) clip.rig.nodes = [];
  if (!clip.rig.bones) clip.rig.bones = [];
  return clip.rig;
}

export function addClip(assetId, trackId = null) {
  const asset = findAsset(assetId);
  if (!asset) return null;
  const type = asset.type === 'audio' ? 'audio' : 'video';
  let track = trackId ? findTrack(trackId) : app.project.tracks.find(item => item.type === type && item.code === (type === 'video' ? 'V1' : 'A1'));
  if (!track) track = app.project.tracks.find(item => item.type === type);
  if (!track || track.type !== type) return null;
  pushUndo('Insert media');
  const clip = {
    id: makeId('clip'), assetId, trackId: track.id,
    durationFrames: type === 'audio' && asset.duration ? Math.max(1, Math.round(asset.duration * app.project.fps)) : Math.round(app.project.fps * 5),
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, keys: { x: [], y: [], scale: [], rotation: [], opacity: [] } },
    rig: type === 'video' && asset.type === 'image' ? { nodes: [], bones: [] } : null,
  };
  app.project.clips.push(clip);
  track.clipIds.push(clip.id);
  app.project.selectedClipId = clip.id;
  app.project.selectedAssetId = assetId;
  app.project.inspectorTab = 'values';
  app.project.selectedNodeId = null;
  app.project.currentFrame = Math.max(0, getTrackDuration(track) - clip.durationFrames);
  app.renderAll();
  return clip;
}

export function removeClip(clipId) {
  const clip = findClip(clipId);
  if (!clip) return;
  pushUndo('Remove clip');
  const track = findTrack(clip.trackId);
  if (track) track.clipIds = track.clipIds.filter(id => id !== clipId);
  app.project.clips = app.project.clips.filter(item => item.id !== clipId);
  if (app.project.selectedClipId === clipId) app.project.selectedClipId = null;
  app.project.selectedNodeId = null;
  app.renderAll();
}

export function addTrack(type) {
  if (type !== 'video' && type !== 'audio') return null;
  const existing = getTracks(type);
  if (existing.length >= 3) return null;
  const index = existing.length + 1;
  pushUndo(`Add ${type} layer`);
  const track = createTrack(type, index);
  app.project.tracks.push(track);
  app.renderAll();
  return track;
}
