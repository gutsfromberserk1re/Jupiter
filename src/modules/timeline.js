import {
  app, findAsset, findClip, findTrack, getTracks, getSequenceDuration,
  clipStartFrame, addTrack, pushUndo,
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
let clipTrimDrag = null;
let keyDrag = null;
let scrubDrag = null;
let suppressClipClickUntil = 0;
let activeDropLane = null;
let activeDropMarker = null;

const propertyLabels = { x: 'Position X', y: 'Position Y', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity' };
const videoOrder = (a, b) => Number(b.code?.slice(1) || 1) - Number(a.code?.slice(1) || 1);
const audioOrder = (a, b) => Number(a.code?.slice(1) || 1) - Number(b.code?.slice(1) || 1);

function durationLabel(frames) {
  const fps = app.project.fps;
  const totalSeconds = Math.floor(frames / fps);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
function frameFromEvent(event) {
  const rect = content.getBoundingClientRect();
  return Math.max(0, Math.round((event.clientX - rect.left) / app.project.timelineZoom));
}
function positiveModulo(value, divisor) {
  return divisor > 0 ? ((value % divisor) + divisor) % divisor : value;
}
function autoScrollAtEdge(event) {
  const rect = scroll.getBoundingClientRect();
  if (event.clientX < rect.left + 22) scroll.scrollLeft = Math.max(0, scroll.scrollLeft - 28);
  else if (event.clientX > rect.right - 22) scroll.scrollLeft += 28;
}
function scrubTo(event) {
  autoScrollAtEdge(event);
  seek(frameFromEvent(event), { scrubbing: true });
}
function startScrub(event) {
  if (event.button !== 0) return;
  app.pausePlayback?.();
  scrubDrag = { pointerId: event.pointerId };
  document.body.classList.add('timeline-scrubbing');
  event.currentTarget.setPointerCapture?.(event.pointerId);
  event.preventDefault();
  scrubTo(event);
}
function seek(frame, { scrubbing = false } = {}) {
  app.project.currentFrame = Math.max(0, Math.min(getSequenceDuration() - 1, Math.round(frame)));
  app.drawStage();
  updatePlayhead();
  const selectionChanged = updateStatus();
  if (!scrubbing || selectionChanged) app.renderInspector();
}
function updatePlayhead() {
  const x = app.project.currentFrame * app.project.timelineZoom;
  playhead.style.left = `${x}px`;
  if (app.project.playing && scroll.clientWidth) {
    const visibleRight = scroll.scrollLeft + scroll.clientWidth;
    if (x > visibleRight - 48) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * .72);
  }
  const line = document.getElementById('playhead-time');
  const fps = app.project.fps;
  const totalSeconds = Math.floor(app.project.currentFrame / fps);
  const frames = app.project.currentFrame % fps;
  line.textContent = `${String(Math.floor(totalSeconds / 3600)).padStart(2, '0')}:${String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
  document.getElementById('frame-label').textContent = `F ${String(app.project.currentFrame).padStart(4, '0')}`;
  document.getElementById('sequence-info').textContent = `${app.project.fps} FPS · ${durationLabel(getSequenceDuration())}`;
}
function updateStatus() {
  const previousSelection = app.project.selectedClipId;
  const videoTracks = getTracks('video').sort(videoOrder);
  let active = null;
  for (const track of videoTracks) {
    let cursor = Math.max(0, Number(track.startFrame) || 0);
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
  return previousSelection !== app.project.selectedClipId;
}

function makeRuler(width, ppf) {
  ruler.innerHTML = '';
  ruler.dataset.generatedWidth = String(width);
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
  row.dataset.trackId = track.id;
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

function visibleKeyFrames(clip, frame) {
  const offset = 0;
  const loop = Math.max(0, Number(clip.loopDurationFrames) || 0);
  if (!loop) {
    const localFrame = frame - offset;
    return localFrame >= 0 && localFrame < clip.durationFrames ? [{ frame: localFrame, cycle: 0 }] : [];
  }
  const firstLocalFrame = positiveModulo(frame - offset, loop);
  const occurrences = [];
  for (let localFrame = firstLocalFrame; localFrame < clip.durationFrames; localFrame += loop) {
    occurrences.push({ frame: localFrame, cycle: Math.floor((offset + localFrame) / loop) });
  }
  return occurrences;
}

function keyMarkersForClip(clip, clipElement, ppf) {
  if (!clip || !clipElement) return;
  const markers = [];
  for (const [row, property] of TRANSFORM_PROPERTIES.entries()) {
    for (const key of clip.transform?.keys?.[property] || []) {
      for (const occurrence of visibleKeyFrames(clip, key.frame)) markers.push({ key, kind: 'transform', property, frame: key.frame, ...occurrence, row });
    }
  }
  for (const [index, node] of (clip.rig?.nodes || []).entries()) {
    for (const key of node.keys || []) {
      for (const occurrence of visibleKeyFrames(clip, key.frame)) markers.push({ key, kind: 'node', nodeId: node.id, property: 'node', frame: key.frame, ...occurrence, row: index % 5 });
    }
  }
  for (const marker of markers) {
    const diamond = document.createElement('button');
    diamond.type = 'button';
    diamond.tabIndex = 0;
    diamond.className = `clip-key ${marker.kind === 'node' ? 'node' : marker.property}`;
    diamond.dataset.keyLane = marker.kind === 'node' ? 'joint' : marker.property;
    diamond.dataset.keyFrame = marker.key.frame;
    diamond.dataset.displayFrame = marker.frame;
    diamond.dataset.timelineFrame = marker.frame;
    diamond.dataset.loopIndex = marker.cycle;
    diamond.dataset.clipId = clip.id;
    diamond.dataset.keyKind = marker.kind;
    if (marker.nodeId) diamond.dataset.nodeId = marker.nodeId;
    if (marker.property) diamond.dataset.property = marker.property;
    diamond.style.left = `${Math.max(4, marker.frame * ppf)}px`;
    diamond.style.top = `${6 + marker.row * 6}px`;
    diamond.setAttribute('aria-label', marker.kind === 'node'
      ? `${clip.rig.nodes.find(node => node.id === marker.nodeId)?.name || 'Joint'} keyframe · frame ${marker.frame}`
      : `${propertyLabels[marker.property]} keyframe · frame ${marker.frame}`);
    diamond.title = diamond.getAttribute('aria-label');
    clipElement.appendChild(diamond);
  }
}

function selectKeyframe(event, button) {
  event.preventDefault();
  event.stopPropagation();
  const clip = findClip(button.dataset.clipId);
  if (!clip) return;
  app.project.selectedClipId = clip.id;
  app.project.selectedAssetId = clip.assetId;
  app.project.selectedNodeId = button.dataset.nodeId || null;
  app.project.inspectorTab = 'values';
  app.project.graphProperty = button.dataset.keyKind === 'node' ? 'node-x' : button.dataset.property;
  seek(clipStartFrame(clip.id) + Number(button.dataset.timelineFrame || 0));
  app.renderInspector();
}

function nearestKeyMarker(clipElement, clientX, clientY) {
  let nearest = null, distance = 18;
  for (const button of clipElement.querySelectorAll('.clip-key')) {
    const rect = button.getBoundingClientRect();
    const candidate = Math.hypot(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2));
    if (candidate < distance) { nearest = button; distance = candidate; }
  }
  return nearest;
}

function createAudioWaveform(asset, clip, clipWidth, fps) {
  const canvas = document.createElement('canvas');
  canvas.className = 'audio-waveform';
  canvas.setAttribute('aria-hidden', 'true');
  const peaks = asset.waveform;
  if (!Array.isArray(peaks) || !peaks.length) {
    app.loadAudioWaveform?.(asset);
    return canvas;
  }
  canvas.width = Math.max(30, Math.min(4096, Math.ceil(clipWidth)));
  canvas.height = 56;
  const context = canvas.getContext('2d');
  const sourceFrames = Math.max(1, Math.round((Number(asset.duration) || clip.loopDurationFrames / fps || clip.durationFrames / fps) * fps));
  const sourceOffset = Number(clip.sourceOffsetFrames) || 0;
  const center = canvas.height / 2;
  const color = getComputedStyle(document.body).getPropertyValue('--waveform-color').trim() || '#5c85a5';
  context.fillStyle = color;
  for (let x = 0; x < canvas.width; x++) {
    const localFrame = (x / canvas.width) * clip.durationFrames;
    const sourceFrame = positiveModulo(sourceOffset + localFrame, sourceFrames);
    const peak = Math.max(.035, Math.min(1, peaks[Math.min(peaks.length - 1, Math.floor(sourceFrame / sourceFrames * peaks.length))] || 0));
    const amplitude = peak * canvas.height * .78;
    context.fillRect(x, center - amplitude / 2, 1, Math.max(1, amplitude));
  }
  return canvas;
}

function addTrimHandle(element, edge, clip) {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = `clip-trim-handle ${edge}`;
  const track = findTrack(clip.trackId);
  const firstClip = track?.clipIds[0] === clip.id;
  handle.title = edge === 'right' ? 'Drag to trim; extending repeats the source' : firstClip ? 'Drag to trim clip start' : 'Drag to roll edit this cut';
  handle.setAttribute('aria-label', edge === 'right' ? 'Trim or extend clip end' : firstClip ? 'Trim clip start' : 'Roll edit clip start');
  handle.addEventListener('pointerdown', event => onClipTrimPointerDown(event, clip, edge));
  handle.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
  element.appendChild(handle);
}

function renderTrack(track, ppf) {
  const existingLane = [...lanes.children].find(item => item.dataset.trackId === track.id);
  const label = trackLabel(track);
  const existingLabel = [...labels.children].find(item => item.dataset.trackId === track.id);
  if (existingLabel) existingLabel.replaceWith(label);
  else labels.appendChild(label);
  const lane = document.createElement('div');
  lane.className = `track-lane ${track.type}`;
  lane.dataset.trackId = track.id;
  lane.dataset.trackType = track.type;
  lane.style.setProperty('--ppf', `${ppf}px`);
  let cursor = Math.max(0, Number(track.startFrame) || 0);
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
    const clipWidth = Math.max(34, clip.durationFrames * ppf);
    element.style.width = `${clipWidth}px`;
    if (asset.type === 'image') {
      const img = document.createElement('img'); img.src = asset.dataUrl; img.alt = ''; element.appendChild(img);
    } else {
      const waveformKey = [clip.durationFrames, Number(clip.sourceOffsetFrames) || 0, Number(clip.loopDurationFrames) || 0, clipWidth, asset.waveform?.length || 0].join(':');
      const oldClipElement = [...(existingLane?.querySelectorAll('.timeline-clip') || [])].find(item => item.dataset.clipId === clip.id);
      const cachedWaveform = oldClipElement?.dataset.waveformKey === waveformKey ? oldClipElement.querySelector('.audio-waveform') : null;
      const waveform = cachedWaveform || createAudioWaveform(asset, clip, clipWidth, app.project.fps);
      element.dataset.waveformKey = waveformKey;
      element.appendChild(waveform);
      const wave = document.createElement('span'); wave.className = 'audio-glyph'; wave.textContent = '▥'; element.appendChild(wave);
    }
    const name = document.createElement('span'); name.className = 'clip-name'; name.textContent = asset.name; element.appendChild(name);
    element.title = `${asset.name} · ${clip.durationFrames} frames`;
    element.addEventListener('pointerdown', event => {
      if (event.target.closest('.clip-trim-handle')) return;
      const marker = nearestKeyMarker(element, event.clientX, event.clientY);
      if (marker) { onKeyPointerDown(event, marker); return; }
      onClipPointerDown(event);
    });
    element.addEventListener('click', event => {
      event.stopPropagation();
      if (Date.now() < suppressClipClickUntil) return;
      const marker = nearestKeyMarker(element, event.clientX, event.clientY);
      if (marker) { selectKeyframe(event, marker); return; }
      app.project.selectedClipId = clip.id;
      app.project.selectedAssetId = asset.id;
      app.project.selectedNodeId = null;
      app.project.inspectorTab = 'values';
      const rect = content.getBoundingClientRect();
      seek(Math.round((event.clientX - rect.left) / ppf));
      app.renderAll();
    });
    lane.appendChild(element);
    addTrimHandle(element, 'left', clip);
    addTrimHandle(element, 'right', clip);
    if (asset.type === 'image') keyMarkersForClip(clip, element, ppf);
    cursor += Math.max(1, clip.durationFrames);
  }
  if (existingLane) existingLane.replaceWith(lane);
  else lanes.appendChild(lane);
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

function updateTimelineExtent(ppf, forceRuler = false) {
  const maxFrames = Math.max(getSequenceDuration() + app.project.fps * 3, app.project.fps * 8, app.project.currentFrame + app.project.fps * 2);
  const width = Math.max(800, (scroll.clientWidth || 800), maxFrames * ppf + 90);
  const oldWidth = Number.parseFloat(content.style.width) || 0;
  if (Math.abs(oldWidth - width) > .5) {
    content.style.width = `${width}px`;
    content.style.minWidth = `${width}px`;
  }
  const rulerWidth = Number(ruler.dataset.generatedWidth) || 0;
  const rulerBuffer = Math.max(32, ppf * app.project.fps / 2);
  const rulerNeedsUpdate = forceRuler || width < rulerWidth - rulerBuffer || width - rulerWidth > rulerBuffer;
  if (rulerNeedsUpdate) makeRuler(width, ppf);
}

function renderTimeline() {
  const ppf = app.project.timelineZoom;
  updateTimelineExtent(ppf, true);
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
  const rect = event.currentTarget.getBoundingClientRect();
  clipDrag = {
    clipId: clip.id,
    fromTrackId: clip.trackId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    grabOffsetFrames: Math.max(0, Math.round((event.clientX - rect.left) / app.project.timelineZoom)),
    element: event.currentTarget,
    moved: false,
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function onClipTrimPointerDown(event, clip, edge) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const track = findTrack(clip.trackId);
  if (!track) return;
  const index = track.clipIds.indexOf(clip.id);
  const previous = edge === 'left' && index > 0 ? findClip(track.clipIds[index - 1]) : null;
  clipTrimDrag = {
    clipId: clip.id,
    previousClipId: previous?.id || null,
    edge,
    pointerId: event.pointerId,
    startX: event.clientX,
    pixelsPerFrame: app.project.timelineZoom,
    durationFrames: clip.durationFrames,
    sourceOffsetFrames: Number(clip.sourceOffsetFrames) || 0,
    previousDurationFrames: previous?.durationFrames || 0,
    trackStartFrame: Math.max(0, Number(track.startFrame) || 0),
    changed: false,
  };
  timelineBody.setPointerCapture?.(event.pointerId);
  app.project.selectedClipId = clip.id;
  app.project.selectedAssetId = clip.assetId;
  app.project.selectedNodeId = null;
  event.currentTarget.parentElement?.classList.add('selected');
  app.renderInspector();
  document.body.classList.add('timeline-trimming');
}

function applyClipTrim(event) {
  const state = clipTrimDrag;
  if (!state || event.pointerId !== state.pointerId) return;
  const clip = findClip(state.clipId);
  if (!clip) return;
  const asset = findAsset(clip.assetId);
  const rawDelta = Math.round((event.clientX - state.startX) / Math.max(.1, state.pixelsPerFrame));
  const maxDuration = app.project.fps * 600;
  let durationFrames = state.durationFrames;
  let sourceOffsetFrames = state.sourceOffsetFrames;
  let previousDurationFrames = state.previousDurationFrames;
  if (state.edge === 'right') {
    durationFrames = Math.max(1, Math.min(maxDuration, state.durationFrames + rawDelta));
  } else {
    const previous = state.previousClipId ? findClip(state.previousClipId) : null;
    const minimumDelta = previous
      ? Math.max(1 - state.previousDurationFrames, state.durationFrames - maxDuration)
      : Math.max(state.durationFrames - maxDuration, -state.trackStartFrame);
    const maximumDelta = previous
      ? Math.min(maxDuration - state.previousDurationFrames, state.durationFrames - 1)
      : state.durationFrames - 1;
    const delta = Math.max(minimumDelta, Math.min(maximumDelta, rawDelta));
    durationFrames = state.durationFrames - delta;
    if (previous) previousDurationFrames = state.previousDurationFrames + delta;
    sourceOffsetFrames = asset?.type === 'audio' ? state.sourceOffsetFrames + delta : 0;
  }
  if (durationFrames === clip.durationFrames
    && (state.edge !== 'left' || previousDurationFrames === state.previousDurationFrames)) return;
  if (!state.changed) { pushUndo(state.edge === 'right' ? 'Trim clip end' : 'Roll edit clip cut'); state.changed = true; }
  clip.durationFrames = durationFrames;
  if (state.edge === 'left') {
    clip.sourceOffsetFrames = sourceOffsetFrames;
    const previous = findClip(state.previousClipId);
    if (previous) previous.durationFrames = previousDurationFrames;
    else {
      const track = findTrack(clip.trackId);
      if (track) track.startFrame = Math.max(0, state.trackStartFrame + (state.durationFrames - durationFrames));
    }
  }
  app.project.currentFrame = Math.min(app.project.currentFrame, getSequenceDuration() - 1);
  const track = findTrack(clip.trackId);
  if (track) renderTrack(track, app.project.timelineZoom);
  updateTimelineExtent(app.project.timelineZoom);
  if (updateStatus()) app.renderInspector();
  app.drawStage();
  updatePlayhead();
}

function finishClipTrim(event) {
  if (!clipTrimDrag || (event?.pointerId != null && event.pointerId !== clipTrimDrag.pointerId)) return;
  const changed = clipTrimDrag.changed;
  clipTrimDrag = null;
  document.body.classList.remove('timeline-trimming');
  if (changed) {
    suppressClipClickUntil = Date.now() + 350;
    app.renderAll();
  }
}

function insertionPosition(track, frame, excludeId = null) {
  const ids = track.clipIds.filter(id => id !== excludeId);
  let cursor = Math.max(0, Number(track.startFrame) || 0);
  for (let i = 0; i < ids.length; i++) {
    const item = findClip(ids[i]);
    if (!item) continue;
    if (frame < cursor + item.durationFrames / 2) return { index: i, frame: cursor };
    cursor += item.durationFrames;
  }
  return { index: ids.length, frame: cursor };
}
function insertionIndex(track, frame, excludeId = null) {
  return insertionPosition(track, frame, excludeId).index;
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

function clearDropPreview() {
  activeDropLane?.classList.remove('drop-target');
  activeDropMarker?.remove();
  activeDropLane = null;
  activeDropMarker = null;
}

function updateClipDropPreview(event) {
  clearDropPreview();
  if (!clipDrag?.moved) return;
  const lane = laneAtPoint(event.clientX, event.clientY);
  if (!lane) return;
  const source = findTrack(clipDrag.fromTrackId);
  const candidateType = lane.dataset.createTrack || findTrack(lane.dataset.trackId)?.type;
  if (!source || candidateType !== source.type) return;
  if (lane.dataset.createTrack && getTracks(source.type).length >= 3) return;
  activeDropLane = lane;
  lane.classList.add('drop-target');
  const track = findTrack(lane.dataset.trackId);
  const frame = Math.max(0, frameFromEvent(event) - clipDrag.grabOffsetFrames);
  const remainingClips = track?.clipIds.filter(id => id !== clipDrag.clipId) || [];
  const insertion = track && remainingClips.length
    ? insertionPosition(track, frame, clipDrag.clipId)
    : { frame };
  const marker = document.createElement('div');
  marker.className = 'timeline-insertion-marker';
  marker.style.left = `${insertion.frame * app.project.timelineZoom}px`;
  lane.appendChild(marker);
  activeDropMarker = marker;
}

function finishClipDrag(event) {
  if (!clipDrag || (event?.pointerId != null && event.pointerId !== clipDrag.pointerId)) return;
  const state = clipDrag; clipDrag = null;
  const clip = findClip(state.clipId);
  const resetVisual = () => {
    if (!state.element) return;
    state.element.style.transform = ''; state.element.style.zIndex = '';
    state.element.style.opacity = ''; state.element.style.pointerEvents = '';
    setAssetDragState(null, false);
    document.body.classList.remove('timeline-clip-dragging');
    clearDropPreview();
  };
  if (!clip || !state.moved) { resetVisual(); return; }
  suppressClipClickUntil = Date.now() + 350;
  const lane = laneAtPoint(event.clientX, event.clientY);
  if (!lane) { resetVisual(); return; }
  const source = findTrack(state.fromTrackId);
  const target = resolveDropTrack(lane, source?.type);
  if (!source || !target || target.type !== source.type) { resetVisual(); return; }
  const frame = Math.max(0, frameFromEvent(event) - state.grabOffsetFrames);
  pushUndo('Move timeline clip');
  source.clipIds = source.clipIds.filter(id => id !== clip.id);
  const targetIds = target.clipIds.filter(id => id !== clip.id);
  if (source !== target && !source.clipIds.length) source.startFrame = 0;
  if (!targetIds.length) target.startFrame = frame;
  target.clipIds = targetIds;
  const insertion = insertionPosition(target, frame);
  target.clipIds.splice(insertion.index, 0, clip.id);
  clip.trackId = target.id;
  app.project.currentFrame = clipStartFrame(clip.id);
  app.project.selectedClipId = clip.id;
  app.project.selectedAssetId = clip.assetId;
  app.project.inspectorTab = 'values';
  setAssetDragState(null, false);
  document.body.classList.remove('timeline-clip-dragging');
  clearDropPreview();
  app.renderAll();
}

function keyArrayForButton(button, clip) {
  if (button.dataset.keyKind === 'transform') return clip?.transform?.keys?.[button.dataset.property] || null;
  const node = clip?.rig?.nodes.find(item => item.id === button.dataset.nodeId);
  return node?.keys || null;
}

function onKeyPointerDown(event, button) {
  event.stopPropagation(); event.preventDefault();
  app.pausePlayback?.();
  const clip = findClip(button.dataset.clipId);
  const frame = Number(button.dataset.keyFrame);
  const keyArray = keyArrayForButton(button, clip);
  const key = keyArray?.find(item => item.frame === frame);
  if (!clip || !key || !keyArray) return;
  keyDrag = {
    clipId: clip.id,
    keyKind: button.dataset.keyKind || 'node',
    nodeId: button.dataset.nodeId || null,
    property: button.dataset.property || null,
    keyArray,
    key,
    button,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startKeyFrame: key.frame,
    startTimelineFrame: Number(button.dataset.timelineFrame || 0),
    grabOffsetFrames: frameFromEvent(event) - clipStartFrame(clip.id) - Number(button.dataset.timelineFrame || 0),
    moved: false,
  };
  app.project.selectedClipId = clip.id;
  app.project.selectedNodeId = keyDrag.nodeId;
  app.project.selectedAssetId = clip.assetId;
  app.project.inspectorTab = 'values';
  app.project.graphProperty = keyDrag.keyKind === 'node' ? 'node-x' : keyDrag.property;
  app.renderInspector();
  event.currentTarget.setPointerCapture?.(event.pointerId);
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
  if (!keyDrag || (event?.pointerId != null && event.pointerId !== keyDrag.pointerId)) return;
  const state = keyDrag; keyDrag = null;
  const clip = findClip(state.clipId); if (!clip) return;
  if (!state.moved) {
    state.key.frame = state.startKeyFrame;
    seek(clipStartFrame(clip.id) + state.startTimelineFrame);
    suppressClipClickUntil = Date.now() + 250;
  } else {
    deduplicateKeys(state.keyArray, state.key);
    app.project.currentFrame = clipStartFrame(clip.id) + Number(state.button.dataset.timelineFrame || state.startTimelineFrame);
    suppressClipClickUntil = Date.now() + 350;
  }
  app.project.inspectorTab = 'values';
  updateStatus();
  app.renderAll();
}

ruler.addEventListener('pointerdown', startScrub);
lanes.addEventListener('pointerdown', event => {
  if (event.target.closest('.timeline-clip, .clip-key, .new-layer-drop')) return;
  startScrub(event);
});
document.querySelector('.playhead-cap')?.addEventListener('pointerdown', startScrub);
window.addEventListener('pointerup', event => {
  finishClipDrag(event);
  finishClipTrim(event);
  finishKeyDrag(event);
  if (scrubDrag && event.pointerId === scrubDrag.pointerId) scrubDrag = null;
  document.body.classList.remove('timeline-scrubbing');
});
window.addEventListener('pointercancel', event => {
  if (clipDrag?.pointerId === event.pointerId) {
    const state = clipDrag;
    clipDrag = null;
    if (state.element) {
      state.element.style.transform = ''; state.element.style.zIndex = '';
      state.element.style.opacity = ''; state.element.style.pointerEvents = '';
    }
    document.body.classList.remove('timeline-clip-dragging');
    setAssetDragState(null, false);
  }
  finishClipTrim(event);
  finishKeyDrag(event);
  if (scrubDrag?.pointerId === event.pointerId) scrubDrag = null;
  document.body.classList.remove('timeline-scrubbing');
});
window.addEventListener('pointermove', event => {
  if (clipDrag && event.pointerId === clipDrag.pointerId && Math.hypot(event.clientX - clipDrag.startX, event.clientY - clipDrag.startY) > 5) {
    if (!clipDrag.moved) setAssetDragState(findTrack(clipDrag.fromTrackId)?.type || null, true, true);
    clipDrag.moved = true;
    document.body.classList.add('timeline-clip-dragging');
    const dx = event.clientX - clipDrag.startX, dy = event.clientY - clipDrag.startY;
    clipDrag.element.style.transform = `translate(${dx}px, ${dy}px)`;
    clipDrag.element.style.zIndex = '20'; clipDrag.element.style.opacity = '.82';
    // Let the pointer reach the destination lane beneath the moving clip.
    clipDrag.element.style.pointerEvents = 'none';
    autoScrollAtEdge(event);
    updateClipDropPreview(event);
  }
  if (clipTrimDrag && event.pointerId === clipTrimDrag.pointerId) applyClipTrim(event);
  if (scrubDrag && event.pointerId === scrubDrag.pointerId) scrubTo(event);
  if (keyDrag && event.pointerId === keyDrag.pointerId) {
    const clip = findClip(keyDrag.clipId);
    if (clip) {
      if (!keyDrag.moved && Math.hypot(event.clientX - keyDrag.startX, event.clientY - keyDrag.startY) > 3) {
        pushUndo('Move keyframe');
        keyDrag.moved = true;
      }
      if (!keyDrag.moved) return;
      autoScrollAtEdge(event);
      const start = clipStartFrame(clip.id);
      const timelineFrame = Math.max(0, Math.min(clip.durationFrames - 1, Math.round(frameFromEvent(event) - start - keyDrag.grabOffsetFrames)));
      const loop = Math.max(0, Number(clip.loopDurationFrames) || 0);
      keyDrag.key.frame = loop ? positiveModulo(timelineFrame, loop) : timelineFrame;
      keyDrag.button.dataset.keyFrame = keyDrag.key.frame;
      keyDrag.button.dataset.timelineFrame = timelineFrame;
      keyDrag.button.dataset.displayFrame = timelineFrame;
      keyDrag.button.style.left = `${Math.max(4, timelineFrame * app.project.timelineZoom)}px`;
      app.project.currentFrame = start + timelineFrame;
      app.drawStage(); updatePlayhead();
    }
  }
});

export function setAssetDragState(type = null, active = true, allowNewTrack = true) {
  timelineBody.classList.toggle('asset-dragging', active && allowNewTrack);
  timelineBody.classList.toggle('clip-dragging', active && !allowNewTrack);
  timelineBody.dataset.dragType = active ? (type || '') : '';
  for (const target of lanes.querySelectorAll('.new-layer-drop')) {
    const available = active && allowNewTrack && target.dataset.createTrack === type && getTracks(type).length < 3;
    target.classList.toggle('available', available);
    target.setAttribute('aria-hidden', String(!available));
  }
  if (!active) clearDropPreview();
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
  if (!track.clipIds.length) track.startFrame = frame;
  const index = insertionIndex(track, frame);
  const clip = {
    id: `clip_${Math.random().toString(36).slice(2, 8)}`,
    assetId,
    trackId: track.id,
    durationFrames: asset.type === 'audio' && asset.duration ? Math.max(1, Math.round(asset.duration * app.project.fps)) : app.project.fps * 5,
    loopDurationFrames: asset.type === 'audio' && asset.duration ? Math.max(1, Math.round(asset.duration * app.project.fps)) : 0,
    sourceOffsetFrames: 0,
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
