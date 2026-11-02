export const makeId = (prefix = 'id') => `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
export const clone = value => JSON.parse(JSON.stringify(value));

export function createProject(name = 'Untitled') {
  const videoTrack = { id: makeId('track'), name: 'Main video', type: 'video', clipIds: [] };
  const audioTrack = { id: makeId('track'), name: 'Audio 1', type: 'audio', clipIds: [] };
  return {
    schemaVersion: 1,
    name,
    fps: 24,
    width: 1920,
    height: 1080,
    assets: [],
    clips: [],
    tracks: [videoTrack, audioTrack],
    selectedAssetId: null,
    selectedClipId: null,
    selectedNodeId: null,
    activeTool: 'select',
    currentFrame: 0,
    playing: false,
    timelineZoom: 4,
    viewZoom: 1,
    viewPan: { x: 0, y: 0 },
    inspectorTab: 'values',
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

export function findTrack(trackId) {
  return app.project.tracks.find(track => track.id === trackId) ?? null;
}
export function findClip(clipId) {
  return app.project.clips.find(clip => clip.id === clipId) ?? null;
}
export function findAsset(assetId) {
  return app.project.assets.find(asset => asset.id === assetId) ?? null;
}
export function clipStartFrame(clipId) {
  for (const track of app.project.tracks) {
    let cursor = 0;
    for (const id of track.clipIds) {
      const clip = findClip(id);
      if (!clip) continue;
      if (id === clipId) return cursor;
      cursor += Math.max(1, clip.durationFrames || 1);
    }
  }
  return 0;
}
export function getTrackDuration(track) {
  return track.clipIds.reduce((sum, id) => sum + Math.max(1, findClip(id)?.durationFrames || 1), 0);
}
export function getSequenceDuration() {
  return Math.max(1, ...app.project.tracks.map(getTrackDuration));
}
export function getActiveClip(frame = app.project.currentFrame) {
  const videoTracks = app.project.tracks.filter(track => track.type === 'video');
  for (const track of [...videoTracks].reverse()) {
    let cursor = 0;
    for (const clipId of track.clipIds) {
      const clip = findClip(clipId);
      if (!clip) continue;
      const end = cursor + clip.durationFrames;
      if (frame >= cursor && frame < end) return { clip, asset: findAsset(clip.assetId), startFrame: cursor, localFrame: frame - cursor, track };
      cursor = end;
    }
  }
  return null;
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
  let track = trackId ? findTrack(trackId) : app.project.tracks.find(t => t.type === (asset.type === 'audio' ? 'audio' : 'video'));
  if (!track) {
    track = { id: makeId('track'), name: asset.type === 'audio' ? `Audio ${app.project.tracks.filter(t => t.type === 'audio').length + 1}` : `Video ${app.project.tracks.filter(t => t.type === 'video').length + 1}`, type: asset.type === 'audio' ? 'audio' : 'video', clipIds: [] };
    app.project.tracks.push(track);
  }
  if (track.type !== (asset.type === 'audio' ? 'audio' : 'video')) return null;
  pushUndo('Insert media');
  const clip = {
    id: makeId('clip'), assetId, trackId: track.id,
    durationFrames: asset.type === 'audio' && asset.duration ? Math.max(1, Math.round(asset.duration * app.project.fps)) : Math.round(app.project.fps * 5),
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, keys: { x: [], y: [], scale: [], rotation: [], opacity: [] } },
    rig: asset.type === 'image' ? { nodes: [], bones: [] } : null,
  };
  app.project.clips.push(clip);
  track.clipIds.push(clip.id);
  app.project.selectedClipId = clip.id;
  app.project.selectedAssetId = assetId;
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
  const count = app.project.tracks.filter(t => t.type === type).length + 1;
  const name = type === 'video' ? `Video ${count}` : `Audio ${count}`;
  pushUndo('Add track');
  app.project.tracks.push({ id: makeId('track'), name, type, clipIds: [] });
  app.renderAll();
}
