import {
  app, findAsset, findClip, findTrack, getTracks, getSequenceDuration,
  getTrackDuration, clipStartFrame, addTrack, pushUndo,
} from './state.js';
import { TRANSFORM_PROPERTIES } from './rig.js';

const labels = document.getElementById('timeline-labels');
const scroll = document.getElementById('timeline-scroll');
const content = document.getElementById('timeline-content');
const ruler = document.getElementById('timeline-ruler');
const lanes = document.getElementById('timeline-lanes');
const playhead = document.getElementById('playhead-line');
const timelineBody = document.getElementById('timeline-body');
scroll.addEventListener('scroll', () => { labels.scrollTop = scroll.scrollTop; });
labels.addEventListener('scroll', () => { scroll.scrollTop = labels.scrollTop; });
let clipDrag = null;
let keyDrag = null;

const propertyLabels = { x: 'Position X', y: 'Position Y', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity' };
const videoOrder = (a, b) => Number(b.code?.slice(1) || 1) - Number(a.code?.slice(1) || 1);
const audioOrder = (a, b) => Number(a.code?.slice(1) || 1) - Number(b.code?.slice(1) || 1);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function durationLabel(frames) {
  const fps = app.project.fps;
  const totalSeconds = Math.floor(frames / fps);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
function frameFromEvent(event) {
  const rect = content.getBoundingClientRect();
  return Math.max(0, Math.round((event.clientX - rect.left) / app.project.timelineZoom));
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
  line.textContent = `${String(Math.floor(totalSeconds / 3600)).padStart(2, '0')}:${String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
  document.getElementById('frame-label').textContent = `F ${String(app.project.currentFrame).padStart(4, '0')}`;
  document.getElementById('sequence-info').textContent = `${app.project.fps} FPS · ${durationLabel(getSequenceDuration())}`;
}
function updateStatus() {
  const videoTracks = getTracks('video').sort(videoOrder);
  let active = null;
  for (const track of videoTracks) {
    let cursor = 0;
    for (const clipId of track.clipIds) {
      const clip = findClip(clipId);
      if (!clip) continue;
      if (app.project.currentFrame >= cursor && app.project.currentFrame < cursor + clip.durationFrames) {
        active = clip;
        break;
      }
      cursor += clip.durationFrames;
    }
    if (active) break;
  }
  const selected = findClip(app.project.selectedClipId);
  const selectedIsActive = selected && selected.trackId && (() => {
    const track = findTrack(selected.trackId);
    if (!track) return false;
    const start = clipStartFrame(selected.id);
    return app.project.currentFrame >= start && app.project.currentFrame < start + selected.durationFrames;
  })();
  if (active && !selectedIsActive) {
    app.project.selectedClipId = active.id;
    app.project.selectedAssetId = active.assetId;
    app.project.selectedNodeId = null;
  }
}

function makeRuler(width, ppf) {
  ruler.innerHTML = '';
  const totalFrames = Math.ceil(width / ppf);
  const majorEvery = app.project.fps;
  const minorEvery = Math.max(1, Math.round(app.project.fps / 4));
  for (let frame = 0; frame <= totalFrames; frame += minorEvery) {
    const tick = document.createElement('div');
    const major = frame % majorEvery === 0;
    tick.className = `ruler-tick${major ? ' major' : ''}`;
    tick.style.left = `${frame * ppf}px`;
    if (major) tick.textContent = durationLabel(frame);
    ruler.appendChild(tick);
  }
}

function trackLabel(track) {
  const row = document.createElement('div');
  row.className = `track-label ${track.type}`;
  row.setAttribute('aria-label', `${track.code || track.name} ${track.type} track`);
  const code = document.createElement('span'); code.className = 'track-code'; code.textContent = track.code || track.name;
  row.append(code);
  return row;
}

function createGhostLane(type) {
  const count = getTracks(type).length;
  if (count >= 3) return null;
  const lane = document.createElement('div');
  lane.className = `new-layer-drop ${type}`;
  lane.dataset.createTrack = type;
  lane.dataset.createTrackCode = `${type === 'video' ? 'V' : 'A'}${count + 1}`;
  lane.textContent = type === 'video' ? `Drop image here to create V${count + 1}` : `Drop audio here to create A${count + 1}`;
  return lane;
}

function keyMarkersForClip(clip, clipElement, ppf) {
  if (!clip || !clipElement) return;
  const markers = [];
  for (const property of TRANSFORM_PROPERTIES) {
    for (const key of clip.transform?.keys?.[property] || []) markers.push({ key, kind: 'transform', property, frame: key.frame });
  }
  for (const node of clip.rig?.nodes || []) {
    for (const key of node.keys || []) markers.push({ key, kind: 'node', nodeId: node.id, property: 'node', frame: key.frame });
  }
  for (const marker of markers) {
    const diamond = document.createElement('button');
    diamond.type = 'button';
    diamond.className = `clip-key ${marker.kind === 'node' ? 'node' : marker.property}`;
    diamond.dataset.keyLane = marker.kind === 'node' ? 'joint' : marker.property;
    diamond.dataset.keyFrame = marker.frame;
    diamond.dataset.clipId = clip.id;
    diamond.dataset.keyKind = marker.kind;
    if (marker.nodeId) diamond.dataset.nodeId = marker.nodeId;
    if (marker.property) diamond.dataset.property = marker.property;
    diamond.style.left = `${Math.max(4, marker.frame * ppf)}px`;
    diamond.title = marker.kind === 'node'
      ? `${clip.rig.nodes.find(node => node.id === marker.nodeId)?.name || 'Joint'} · frame ${marker.frame}`
      : `${propertyLabels[marker.property]} · frame ${marker.frame}`;
    diamond.addEventListener('pointerdown', onKeyPointerDown);
    diamond.addEventListener('click', event => {
      event.stopPropagation();
      const start = clipStartFrame(clip.id);
      seek(start + marker.frame);
      app.project.selectedClipId = clip.id;
      app.project.inspectorTab = 'values';
      app.project.selectedNodeId = marker.nodeId || null;
      app.project.graphProperty = marker.kind === 'node' ? 'node-x' : marker.property;
      app.renderInspector();
    });
    clipElement.appendChild(diamond);
  }
}

function renderTrack(track, ppf) {
  labels.appendChild(trackLabel(track));
  const lane = document.createElement('div');
  lane.className = `track-lane ${track.type}`;
  lane.dataset.trackId = track.id;
  lane.dataset.trackType = track.type;
  lane.style.setProperty('--ppf', `${ppf}px`);
  let cursor = 0;
  for (const clipId of track.clipIds) {
    const clip = findClip(clipId);
    if (!clip) continue;
    const asset = findAsset(clip.assetId);
    if (!asset) continue;
    const element = document.createElement('div');
    element.className = `timeline-clip ${track.type}${clip.id === app.project.selectedClipId ? ' selected' : ''}`;
    element.dataset.clipId = clip.id;
    element.dataset.trackId = track.id;
    element.style.left = `${cursor * ppf}px`;
    element.style.width = `${Math.max(28, clip.durationFrames * ppf)}px`;
    if (asset.type === 'image') {
      const img = document.createElement('img'); img.src = asset.dataUrl; img.alt = ''; element.appendChild(img);
    } else {
      const wave = document.createElement('span'); wave.className = 'audio-glyph'; wave.textContent = '▥'; element.appendChild(wave);
    }
    const name = document.createElement('span'); name.textContent = asset.name; element.appendChild(name);
    element.title = `${asset.name} · ${clip.durationFrames} frames`;
    element.addEventListener('pointerdown', onClipPointerDown);
    element.addEventListener('click', event => {
      event.stopPropagation();
      if (clipDrag?.moved) return;
      app.project.selectedClipId = clip.id;
      app.project.selectedAssetId = asset.id;
      app.project.selectedNodeId = null;
      app.project.inspectorTab = 'values';
      const rect = content.getBoundingClientRect();
      seek(Math.round((event.clientX - rect.left) / ppf));
      app.renderAll();
    });
    lane.appendChild(element);
    if (asset.type === 'image') keyMarkersForClip(clip, element, ppf);
    cursor += Math.max(1, clip.durationFrames);
  }
  lanes.appendChild(lane);
}

function renderTrackRows() {
  labels.innerHTML = '<div class="timeline-label-spacer"></div>';
  lanes.innerHTML = '';
  const ppf = app.project.timelineZoom;
  const video = getTracks('video').sort(videoOrder);
  const audio = getTracks('audio').sort(audioOrder);
  const videoGhost = createGhostLane('video');
  if (videoGhost) { const spacer = document.createElement('div'); spacer.className = 'new-layer-label video'; labels.appendChild(spacer); lanes.appendChild(videoGhost); }
  for (const track of video) renderTrack(track, ppf);
  for (const track of audio) renderTrack(track, ppf);
  const audioGhost = createGhostLane('audio');
  if (audioGhost) { const spacer = document.createElement('div'); spacer.className = 'new-layer-label audio'; labels.appendChild(spacer); lanes.appendChild(audioGhost); }
}

function renderTimeline() {
  const ppf = app.project.timelineZoom;
  const maxFrames = Math.max(getSequenceDuration() + app.project.fps * 3, app.project.fps * 8, app.project.currentFrame + app.project.fps * 2);
  const width = Math.max(800, (scroll.clientWidth || 800), maxFrames * ppf + 90);
  content.style.width = `${width}px`;
  content.style.minWidth = `${width}px`;
  makeRuler(width, ppf);
  renderTrackRows();
  updatePlayhead();
  document.getElementById('timeline-zoom-in').disabled = ppf >= 12;
  document.getElementById('timeline-zoom-out').disabled = ppf <= 1.5;
}

let timelineResizeFrame = 0;
const redrawTimelineAfterResize = () => {
  if (timelineResizeFrame) cancelAnimationFrame(timelineResizeFrame);
  timelineResizeFrame = requestAnimationFrame(() => {
    timelineResizeFrame = 0;
    renderTimeline();
  });
};
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(redrawTimelineAfterResize).observe(scroll);
} else {
  window.addEventListener('resize', redrawTimelineAfterResize);
}

function onClipPointerDown(event) {
  if (event.button !== 0) return;
  const clip = findClip(event.currentTarget.dataset.clipId);
  if (!clip) return;
  clipDrag = {
    clipId: clip.id,
    fromTrackId: clip.trackId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    element: event.currentTarget,
    moved: false,
  };
  event.preventDefault();
}

function insertionIndex(track, frame, excludeId = null) {
  const ids = track.clipIds.filter(id => id !== excludeId);
  let cursor = 0;
  for (let i = 0; i < ids.length; i++) {
    const item = findClip(ids[i]);
    if (!item) continue;
    if (frame < cursor + item.durationFrames / 2) return i;
    cursor += item.durationFrames;
  }
  return ids.length;
}

function laneAtPoint(clientX, clientY) {
  const hit = document.elementFromPoint(clientX, clientY)?.closest('.track-lane, .new-layer-drop');
  if (hit) return hit;
  // WebView2 can report an overlay/playhead as the hit target while dragging.
  // Resolve the lane geometrically as a fallback so drops still land on V1/A1.
  const candidates = [...lanes.querySelectorAll('.track-lane, .new-layer-drop')];
  return candidates.find(lane => {
    const rect = lane.getBoundingClientRect();
    return clientY >= rect.top && clientY <= rect.bottom;
  }) || null;
}

function resolveDropTrack(lane, expectedType) {
  if (!lane) return getTracks(expectedType)[0] || null;
  if (lane.dataset.createTrack === expectedType) return addTrack(expectedType);
  const track = findTrack(lane.dataset.trackId);
  return track?.type === expectedType ? track : null;
}

function finishClipDrag(event) {
  if (!clipDrag) return;
  const state = clipDrag; clipDrag = null;
  const clip = findClip(state.clipId);
  const resetVisual = () => {
    if (!state.element) return;
    state.element.style.transform = ''; state.element.style.zIndex = '';
    state.element.style.opacity = ''; state.element.style.pointerEvents = '';
    setAssetDragState(null, false);
  };
  if (!clip || !state.moved) { resetVisual(); return; }
  const lane = laneAtPoint(event.clientX, event.clientY);
  if (!lane) { resetVisual(); return; }
  const source = findTrack(state.fromTrackId);
  const target = resolveDropTrack(lane, source?.type);
  if (!source || !target || target.type !== source.type) { resetVisual(); return; }
  const frame = frameFromEvent(event);
  pushUndo('Move timeline clip');
  source.clipIds = source.clipIds.filter(id => id !== clip.id);
  const targetIds = target.clipIds.filter(id => id !== clip.id);
  const index = insertionIndex({ clipIds: targetIds }, frame, null);
  targetIds.splice(index, 0, clip.id);
  target.clipIds = targetIds;
  clip.trackId = target.id;
  app.project.currentFrame = clipStartFrame(clip.id);
  app.project.selectedClipId = clip.id;
  app.project.selectedAssetId = clip.assetId;
  app.project.inspectorTab = 'values';
  setAssetDragState(null, false);
  app.renderAll();
}

function keyArrayForButton(button, clip) {
  if (button.dataset.keyKind === 'transform') return clip?.transform?.keys?.[button.dataset.property] || null;
  const node = clip?.rig?.nodes.find(item => item.id === button.dataset.nodeId);
  return node?.keys || null;
}

function onKeyPointerDown(event) {
  event.stopPropagation(); event.preventDefault();
  const button = event.currentTarget;
  const clip = findClip(button.dataset.clipId);
  const frame = Number(button.dataset.keyFrame);
  const keyArray = keyArrayForButton(button, clip);
  const key = keyArray?.find(item => item.frame === frame);
  if (!clip || !key || !keyArray) return;
  pushUndo('Move keyframe');
  keyDrag = {
    clipId: clip.id,
    keyKind: button.dataset.keyKind || 'node',
    nodeId: button.dataset.nodeId || null,
    property: button.dataset.property || null,
    keyArray,
    key,
    button,
  };
  app.project.selectedClipId = clip.id;
  app.project.selectedNodeId = keyDrag.nodeId;
  app.project.selectedAssetId = clip.assetId;
  app.project.inspectorTab = 'values';
  app.project.graphProperty = keyDrag.keyKind === 'node' ? 'node-x' : keyDrag.property;
  app.renderInspector();
  button.setPointerCapture?.(event.pointerId);
}

function deduplicateKeys(keys, movedKey) {
  const collision = keys.find(item => item !== movedKey && item.frame === movedKey.frame);
  if (collision) {
    if ('x' in movedKey) { collision.x = movedKey.x; collision.y = movedKey.y; }
    if ('value' in movedKey) collision.value = movedKey.value;
    const index = keys.indexOf(movedKey);
    if (index >= 0) keys.splice(index, 1);
  }
  keys.sort((a, b) => a.frame - b.frame);
}

function finishKeyDrag(event) {
  if (!keyDrag) return;
  const state = keyDrag; keyDrag = null;
  const clip = findClip(state.clipId); if (!clip) return;
  state.key.frame = Math.max(0, Math.min(clip.durationFrames - 1, Math.round(frameFromEvent(event) - clipStartFrame(clip.id))));
  deduplicateKeys(state.keyArray, state.key);
  app.project.currentFrame = clipStartFrame(clip.id) + state.key.frame;
  app.project.inspectorTab = 'values';
  app.renderAll();
}

ruler.addEventListener('pointerdown', event => { seek(frameFromEvent(event)); ruler.setPointerCapture?.(event.pointerId); });
ruler.addEventListener('pointermove', event => { if (event.buttons & 1) seek(frameFromEvent(event)); });
lanes.addEventListener('pointerdown', event => {
  if (event.target.closest('.timeline-clip, .clip-key, .new-layer-drop')) return;
  seek(frameFromEvent(event));
});
window.addEventListener('pointerup', event => { finishClipDrag(event); finishKeyDrag(event); });
window.addEventListener('pointermove', event => {
  if (clipDrag && Math.hypot(event.clientX - clipDrag.startX, event.clientY - clipDrag.startY) > 5) {
    if (!clipDrag.moved) setAssetDragState(findTrack(clipDrag.fromTrackId)?.type || null, true);
    clipDrag.moved = true;
    const dx = event.clientX - clipDrag.startX, dy = event.clientY - clipDrag.startY;
    clipDrag.element.style.transform = `translate(${dx}px, ${dy}px)`;
    clipDrag.element.style.zIndex = '20'; clipDrag.element.style.opacity = '.82';
    // Let the pointer reach the destination lane beneath the moving clip.
    clipDrag.element.style.pointerEvents = 'none';
  }
  if (keyDrag) {
    const clip = findClip(keyDrag.clipId);
    if (clip) {
      const start = clipStartFrame(clip.id);
      keyDrag.key.frame = Math.max(0, Math.min(clip.durationFrames - 1, Math.round(frameFromEvent(event) - start)));
      keyDrag.button.style.left = `${Math.max(4, keyDrag.key.frame * app.project.timelineZoom)}px`;
      app.project.currentFrame = start + keyDrag.key.frame;
      app.drawStage(); updatePlayhead();
    }
  }
});

export function setAssetDragState(type = null, active = true) {
  timelineBody.classList.toggle('asset-dragging', active);
  timelineBody.dataset.dragType = active ? (type || '') : '';
  for (const target of lanes.querySelectorAll('.new-layer-drop')) {
    const available = active && target.dataset.createTrack === type && getTracks(type).length < 3;
    target.classList.toggle('available', available);
    target.setAttribute('aria-hidden', String(!available));
  }
}

export function zoomTimeline(direction) {
  const old = app.project.timelineZoom;
  const focusFrame = (scroll.scrollLeft + scroll.clientWidth * .5) / Math.max(.001, old);
  app.project.timelineZoom = Math.max(1.5, Math.min(12, old + direction * .7));
  renderTimeline();
  scroll.scrollLeft = Math.max(0, focusFrame * app.project.timelineZoom - scroll.clientWidth * .5);
  updatePlayhead();
}
export function seekFrame(frame) { seek(frame); }
export function refreshTimeline() { renderTimeline(); }
export function updateTimelinePlayhead() { const previous = app.project.selectedClipId; updateStatus(); updatePlayhead(); if (previous !== app.project.selectedClipId) app.renderInspector(); }

export function handleTimelineDrop(assetId, clientX, clientY = null) {
  const asset = findAsset(assetId);
  if (!asset) {
    window.jupiterToast?.('That media item is no longer in the Media library.');
    return false;
  }
  const expectedType = asset.type === 'audio' ? 'audio' : 'video';
  const lane = Number.isFinite(clientY) ? laneAtPoint(clientX, clientY) : null;
  const track = resolveDropTrack(lane, expectedType);
  if (!track) {
    window.jupiterToast?.(`No ${expectedType} layer is available. Add another layer or drop onto a matching track.`);
    setAssetDragState(null, false);
    return false;
  }
  const frame = frameFromEvent({ clientX });
  const index = insertionIndex(track, frame);
  const clip = {
    id: `clip_${Math.random().toString(36).slice(2, 8)}`,
    assetId,
    trackId: track.id,
    durationFrames: asset.type === 'audio' && asset.duration ? Math.max(1, Math.round(asset.duration * app.project.fps)) : app.project.fps * 5,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, keys: { x: [], y: [], scale: [], rotation: [], opacity: [] } },
    rig: asset.type === 'image' ? { nodes: [], bones: [] } : null,
  };
  pushUndo('Insert media');
  app.project.clips.push(clip);
  track.clipIds.splice(index, 0, clip.id);
  app.project.selectedClipId = clip.id;
  app.project.selectedAssetId = asset.id;
  app.project.selectedNodeId = null;
  app.project.inspectorTab = 'values';
  app.project.currentFrame = clipStartFrame(clip.id);
  setAssetDragState(null, false);
  app.renderAll();
  return true;
}

renderTimeline();
