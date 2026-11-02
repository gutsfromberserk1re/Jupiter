import { app, findAsset, findClip, findTrack, getActiveClip, getSequenceDuration, getTrackDuration, clipStartFrame, pushUndo } from './state.js';
import { TRANSFORM_PROPERTIES } from './rig.js';

const labels = document.getElementById('timeline-labels');
const scroll = document.getElementById('timeline-scroll');
const content = document.getElementById('timeline-content');
const ruler = document.getElementById('timeline-ruler');
const lanes = document.getElementById('timeline-lanes');
const playhead = document.getElementById('playhead-line');
scroll.addEventListener('scroll', () => { labels.scrollTop = scroll.scrollTop; });
labels.addEventListener('scroll', () => { scroll.scrollTop = labels.scrollTop; });
let clipDrag = null;
let keyDrag = null;

function rowLabel(title, kind = 'video', detail = '') {
  const row = document.createElement('div');
  row.className = `track-label ${kind}`;
  row.innerHTML = `<span class="track-dot"></span><span title="${escapeHtml(title)}">${escapeHtml(title)}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}`;
  return row;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function durationLabel(frames) {
  const fps = app.project.fps;
  const seconds = Math.floor(frames / fps);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
}
function frameFromEvent(event) {
  const rect = content.getBoundingClientRect();
  const x = event.clientX - rect.left;
  return Math.max(0, Math.round(x / app.project.timelineZoom));
}
function seek(frame) {
  app.project.currentFrame = Math.max(0, Math.min(getSequenceDuration() - 1, Math.round(frame)));
  app.drawStage();
  updatePlayhead();
  updateStatus();
  app.renderInspector();
}
function updatePlayhead() {
  const x = app.project.currentFrame * app.project.timelineZoom;
  playhead.style.left = `${x}px`;
  const line = document.getElementById('playhead-time');
  const fps = app.project.fps;
  const totalSeconds = Math.floor(app.project.currentFrame / fps);
  const frames = app.project.currentFrame % fps;
  line.textContent = `${String(Math.floor(totalSeconds / 3600)).padStart(2,'0')}:${String(Math.floor((totalSeconds % 3600) / 60)).padStart(2,'0')}:${String(totalSeconds % 60).padStart(2,'0')}:${String(frames).padStart(2,'0')}`;
  document.getElementById('frame-label').textContent = `F ${String(app.project.currentFrame).padStart(4,'0')}`;
  document.getElementById('sequence-info').textContent = `${app.project.fps} FPS · ${durationLabel(getSequenceDuration())}`;
}
function updateStatus() {
  const active = getActiveClip(app.project.currentFrame);
  if (active?.clip && active.clip.id !== app.project.selectedClipId) {
    app.project.selectedClipId = active.clip.id;
    app.project.selectedAssetId = active.asset?.id ?? null;
    app.project.selectedNodeId = null;
    renderTrackRows();
    app.renderInspector();
  }
}

function makeRuler(width, ppf) {
  ruler.innerHTML = '';
  const totalFrames = Math.ceil(width / ppf);
  const fps = app.project.fps;
  const majorEvery = fps;
  const minorEvery = Math.max(1, Math.round(fps / 4));
  for (let frame = 0; frame <= totalFrames; frame += minorEvery) {
    const tick = document.createElement('div');
    const major = frame % majorEvery === 0;
    tick.className = `ruler-tick${major ? ' major' : ''}`;
    tick.style.left = `${frame * ppf}px`;
    if (major) tick.textContent = durationLabel(frame);
    ruler.appendChild(tick);
  }
}

function renderTrackRows() {
  labels.innerHTML = '<div class="timeline-label-spacer"></div>';
  lanes.innerHTML = '';
  const selectedClip = findClip(app.project.selectedClipId);
  const ppf = app.project.timelineZoom;
  for (const track of app.project.tracks) {
    labels.appendChild(rowLabel(track.name, track.type));
    const lane = document.createElement('div');
    lane.className = 'track-lane'; lane.dataset.trackId = track.id; lane.dataset.trackType = track.type;
    lane.style.setProperty('--ppf', `${ppf}px`);
    let cursor = 0;
    for (const clipId of track.clipIds) {
      const clip = findClip(clipId); if (!clip) continue;
      const asset = findAsset(clip.assetId); if (!asset) continue;
      const element = document.createElement('div');
      element.className = `timeline-clip ${track.type}${clip.id === app.project.selectedClipId ? ' selected' : ''}`;
      element.dataset.clipId = clip.id; element.dataset.trackId = track.id;
      element.style.left = `${cursor * ppf}px`;
      element.style.width = `${Math.max(24, clip.durationFrames * ppf)}px`;
      if (asset.type === 'image') {
        const img = document.createElement('img'); img.src = asset.dataUrl; img.alt = ''; element.appendChild(img);
      } else {
        const wave = document.createElement('span'); wave.textContent = '∿'; wave.style.fontSize = '15px'; element.appendChild(wave);
      }
      const name = document.createElement('span'); name.textContent = asset.name; element.appendChild(name);
      element.title = `${asset.name} · ${clip.durationFrames} frames`;
      element.addEventListener('pointerdown', onClipPointerDown);
      element.addEventListener('click', event => { event.stopPropagation(); app.project.selectedClipId = clip.id; app.project.selectedAssetId = asset.id; app.project.selectedNodeId = null; app.project.currentFrame = clipStartFrame(clip.id); app.renderAll(); });
      lane.appendChild(element);
      cursor += clip.durationFrames;
    }
    lanes.appendChild(lane);

    if (track.type === 'video' && selectedClip && selectedClip.trackId === track.id) {
      const start = clipStartFrame(selectedClip.id);
      const asset = findAsset(selectedClip.assetId);
      if (asset?.type === 'image') {
        const propertyNames = { x: 'Position X', y: 'Position Y', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity' };
        for (const property of TRANSFORM_PROPERTIES) {
          const keys = selectedClip.transform?.keys?.[property] || [];
          labels.appendChild(rowLabel(propertyNames[property], 'video', 'LAYER'));
          const keyLane = document.createElement('div'); keyLane.className = 'track-lane key-lane transform-key-lane';
          keyLane.dataset.trackId = track.id; keyLane.dataset.keyKind = 'transform'; keyLane.dataset.property = property;
          keyLane.style.setProperty('--ppf', `${ppf}px`);
          for (const key of keys) {
            const diamond = document.createElement('button');
            diamond.className = `key-diamond transform-key ${property}`; diamond.type = 'button';
            diamond.dataset.keyFrame = key.frame; diamond.dataset.clipId = selectedClip.id; diamond.dataset.keyKind = 'transform'; diamond.dataset.property = property;
            diamond.style.left = `${(start + key.frame) * ppf}px`;
            diamond.title = `${propertyNames[property]} · ${Number(key.value).toFixed(2)} · frame ${key.frame}`;
            diamond.addEventListener('pointerdown', onKeyPointerDown);
            diamond.addEventListener('click', event => { event.stopPropagation(); seek(start + key.frame); app.project.selectedClipId = selectedClip.id; app.project.selectedNodeId = null; app.renderInspector(); });
            keyLane.appendChild(diamond);
          }
          lanes.appendChild(keyLane);
        }
      }
      for (const node of selectedClip.rig?.nodes || []) {
        labels.appendChild(rowLabel(node.name, 'video', 'JOINT'));
        const keyLane = document.createElement('div'); keyLane.className = 'track-lane key-lane';
        keyLane.dataset.trackId = track.id; keyLane.dataset.nodeId = node.id; keyLane.dataset.keyKind = 'node';
        keyLane.style.setProperty('--ppf', `${ppf}px`);
        for (const key of node.keys || []) {
          const diamond = document.createElement('button');
          diamond.className = 'key-diamond'; diamond.type = 'button'; diamond.dataset.keyFrame = key.frame; diamond.dataset.nodeId = node.id; diamond.dataset.clipId = selectedClip.id; diamond.dataset.keyKind = 'node';
          diamond.style.left = `${(start + key.frame) * ppf}px`; diamond.title = `${node.name} · frame ${key.frame}`;
          diamond.addEventListener('pointerdown', onKeyPointerDown);
          diamond.addEventListener('click', event => { event.stopPropagation(); seek(start + key.frame); app.project.selectedNodeId = node.id; app.renderInspector(); });
          keyLane.appendChild(diamond);
        }
        lanes.appendChild(keyLane);
      }
    }
  }
}

function renderTimeline() {
  const ppf = app.project.timelineZoom;
  const maxFrames = Math.max(getSequenceDuration() + app.project.fps * 3, app.project.fps * 8, app.project.currentFrame + app.project.fps * 2);
  const needed = maxFrames * ppf + 90;
  const minWidth = Math.max(900, scroll.clientWidth || 900);
  const width = Math.max(minWidth, needed);
  content.style.width = `${width}px`;
  content.style.minWidth = `${width}px`;
  makeRuler(width, ppf);
  renderTrackRows();
  updatePlayhead();
  document.getElementById('timeline-zoom-in').disabled = ppf >= 12;
  document.getElementById('timeline-zoom-out').disabled = ppf <= 1.5;
}

function onClipPointerDown(event) {
  if (event.button !== 0) return;
  const clipId = event.currentTarget.dataset.clipId;
  const clip = findClip(clipId); if (!clip) return;
  clipDrag = { clipId, fromTrackId: clip.trackId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}
function finishClipDrag(event) {
  if (!clipDrag) return;
  const state = clipDrag; clipDrag = null;
  const clip = findClip(state.clipId); if (!clip || !state.moved) return;
  const lane = document.elementFromPoint(event.clientX, event.clientY)?.closest('.track-lane');
  if (!lane) return;
  const targetTrack = findTrack(lane.dataset.trackId);
  const sourceTrack = findTrack(state.fromTrackId);
  if (!targetTrack || !sourceTrack || targetTrack.type !== sourceTrack.type) return;
  const rect = content.getBoundingClientRect();
  const frame = Math.max(0, (event.clientX - rect.left) / app.project.timelineZoom);
  pushUndo('Move timeline clip');
  sourceTrack.clipIds = sourceTrack.clipIds.filter(id => id !== clip.id);
  const targetIds = targetTrack.clipIds.filter(id => id !== clip.id);
  let cursor = 0, index = targetIds.length;
  for (let i = 0; i < targetIds.length; i++) {
    const item = findClip(targetIds[i]); if (!item) continue;
    const midpoint = cursor + item.durationFrames / 2;
    if (frame < midpoint) { index = i; break; }
    cursor += item.durationFrames;
  }
  targetIds.splice(index, 0, clip.id);
  targetTrack.clipIds = targetIds;
  clip.trackId = targetTrack.id;
  app.project.currentFrame = clipStartFrame(clip.id);
  app.renderAll();
}

function keyArrayForButton(button, clip) {
  if (button.dataset.keyKind === 'transform') {
    return clip?.transform?.keys?.[button.dataset.property] || null;
  }
  const node = clip?.rig?.nodes.find(item => item.id === button.dataset.nodeId);
  return node?.keys || null;
}

function onKeyPointerDown(event) {
  event.stopPropagation(); event.preventDefault();
  const button = event.currentTarget;
  const clipId = button.dataset.clipId;
  const clip = findClip(clipId);
  const keyFrame = Number(button.dataset.keyFrame);
  const keyArray = keyArrayForButton(button, clip);
  const key = keyArray?.find(item => item.frame === keyFrame);
  if (!key || !keyArray) return;
  pushUndo('Move keyframe');
  keyDrag = {
    clipId,
    keyKind: button.dataset.keyKind || 'node',
    nodeId: button.dataset.nodeId || null,
    property: button.dataset.property || null,
    keyArray,
    key,
  };
  if (keyDrag.nodeId) app.project.selectedNodeId = keyDrag.nodeId;
  else app.project.selectedNodeId = null;
  app.project.selectedClipId = clipId;
}

function deduplicateKeys(keys, movedKey) {
  const sameFrame = keys.find(item => item !== movedKey && item.frame === movedKey.frame);
  if (sameFrame) {
    if ('x' in movedKey) { sameFrame.x = movedKey.x; sameFrame.y = movedKey.y; }
    if ('value' in movedKey) sameFrame.value = movedKey.value;
    const index = keys.indexOf(movedKey);
    if (index >= 0) keys.splice(index, 1);
  }
  keys.sort((a, b) => a.frame - b.frame);
}

function finishKeyDrag(event) {
  if (!keyDrag) return;
  const state = keyDrag; keyDrag = null;
  const clip = findClip(state.clipId); if (!clip) return;
  const start = clipStartFrame(clip.id);
  const newFrame = Math.max(0, Math.min(clip.durationFrames - 1, Math.round(frameFromEvent(event) - start)));
  state.key.frame = newFrame;
  deduplicateKeys(state.keyArray, state.key);
  app.project.currentFrame = start + newFrame;
  app.renderAll();
}

ruler.addEventListener('pointerdown', event => { seek(frameFromEvent(event)); ruler.setPointerCapture?.(event.pointerId); });
ruler.addEventListener('pointermove', event => { if (event.buttons & 1) seek(frameFromEvent(event)); });
lanes.addEventListener('pointerdown', event => {
  if (event.target.closest('.timeline-clip, .key-diamond')) return;
  const row = event.target.closest('.track-lane');
  if (row && row.classList.contains('key-lane')) return;
  seek(frameFromEvent(event));
});
window.addEventListener('pointerup', event => { finishClipDrag(event); finishKeyDrag(event); });
window.addEventListener('pointermove', event => {
  if (clipDrag && Math.hypot(event.clientX - clipDrag.startX, event.clientY - clipDrag.startY) > 5) clipDrag.moved = true;
  if (keyDrag) {
    const clip = findClip(keyDrag.clipId);
    if (clip) {
      const start = clipStartFrame(clip.id);
      keyDrag.key.frame = Math.max(0, Math.min(clip.durationFrames - 1, Math.round(frameFromEvent(event) - start)));
      keyDrag.keyArray.sort((a, b) => a.frame - b.frame);
      app.project.currentFrame = start + keyDrag.key.frame;
      app.drawStage(); updatePlayhead();
    }
  }
});

export function zoomTimeline(direction) {
  app.project.timelineZoom = Math.max(1.5, Math.min(12, app.project.timelineZoom + direction * .7));
  renderTimeline();
}
export function seekFrame(frame) { seek(frame); }
export function refreshTimeline() { renderTimeline(); }
export function updateTimelinePlayhead() { updateStatus(); updatePlayhead(); }
export function handleTimelineDrop(assetId, clientX, clientY = null) {
  const asset = app.project.assets.find(item => item.id === assetId); if (!asset) return;
  const expectedType = asset.type === 'audio' ? 'audio' : 'video';
  const dropLane = Number.isFinite(clientY) ? document.elementFromPoint(clientX, clientY)?.closest('.track-lane') : null;
  const droppedTrack = dropLane ? findTrack(dropLane.dataset.trackId) : null;
  const track = droppedTrack?.type === expectedType ? droppedTrack : app.project.tracks.find(t => t.type === expectedType);
  if (!track) return;
  const rect = content.getBoundingClientRect();
  const frame = Math.max(0, Math.round((clientX - rect.left) / app.project.timelineZoom));
  const targetIds = [...track.clipIds];
  let cursor = 0, index = targetIds.length;
  for (let i = 0; i < targetIds.length; i++) {
    const clip = findClip(targetIds[i]); if (!clip) continue;
    if (frame < cursor + clip.durationFrames / 2) { index = i; break; }
    cursor += clip.durationFrames;
  }
  const clip = {
    id: `clip_${Math.random().toString(36).slice(2,8)}`, assetId, trackId: track.id,
    durationFrames: asset.type === 'audio' && asset.duration ? Math.max(1, Math.round(asset.duration * app.project.fps)) : app.project.fps * 5,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, keys: { x: [], y: [], scale: [], rotation: [], opacity: [] } },
    rig: asset.type === 'image' ? { nodes: [], bones: [] } : null,
  };
  pushUndo('Insert media');
  app.project.clips.push(clip); targetIds.splice(index, 0, clip.id); track.clipIds = targetIds;
  app.project.selectedClipId = clip.id; app.project.selectedAssetId = asset.id;
  app.project.currentFrame = clipStartFrame(clip.id);
  app.renderAll();
}

renderTimeline();
