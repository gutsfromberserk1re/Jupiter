import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { app, createProject, makeId, pushUndo, undo, redo, addClip, removeClip, addTrack, findAsset, findClip, findTrack, getActiveClip, clipStartFrame, getSequenceDuration } from './modules/state.js';
import { loadImageAsset, refreshStage, setTool, renderStageNow } from './modules/stage.js';
import { evaluateNode, setNodePose, evaluateClipTransform, setClipTransformValue, TRANSFORM_PROPERTIES, deleteNode } from './modules/rig.js';
import { zoomTimeline, seekFrame, refreshTimeline, updateTimelinePlayhead, handleTimelineDrop, setAssetDragState } from './modules/timeline.js';
import { detectMediaKind, mediaMime, nativeAssetBase64, setAssetTransfer, hasAssetTransferType, readAssetTransfer } from './modules/media-io.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const tauriMode = !!window.__TAURI_INTERNALS__;
let playbackRequest = 0;
let playbackAnchor = 0;
let playbackStartFrame = 0;
let projectPath = null;
let spaceHeld = false;
let currentAudio = new Map();
let activeDraggedAssetId = null;
let mediaImportBusy = false;
let mediaPointerDrag = null;
let mediaDragGhost = null;
let suppressMediaClick = false;

window.jupiterToast = message => {
  const region = $('#toast-region');
  const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = message;
  region.appendChild(toast); setTimeout(() => toast.remove(), 2900);
};

function setProjectName(name) {
  app.project.name = name || 'Untitled Project';
  $('#project-name').textContent = app.project.name;
  $('#sequence-name').textContent = `${app.project.name} sequence`;
  $('#fps-select').value = String(app.project.fps || 24);
  document.title = `${app.project.name} · Jupiter`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
  });
}
function audioBufferToWavBase64(buffer) {
  const channels = buffer.numberOfChannels, samples = buffer.length;
  const bytes = new Uint8Array(44 + samples * channels * 2);
  const view = new DataView(bytes.buffer);
  const putText = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  putText(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); putText(8, 'WAVE');
  putText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  putText(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  let offset = 44;
  const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  for (let i = 0; i < samples; i++) for (let channel = 0; channel < channels; channel++) {
    const sample = Math.max(-1, Math.min(1, channelData[channel][i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true); offset += 2;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
async function renderProjectAudio(frameCount, fps) {
  const audioClips = app.project.tracks.filter(track => track.type === 'audio').flatMap(track => track.clipIds)
    .map(id => findClip(id)).filter(Boolean).map(clip => ({ clip, asset: findAsset(clip.assetId) }))
    .filter(item => item.asset?.type === 'audio');
  if (!audioClips.length) return null;
  const AudioContextType = window.AudioContext || window.webkitAudioContext;
  const OfflineAudioContextType = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioContextType || !OfflineAudioContextType) throw new Error('This system cannot mix audio for export.');
  const sampleRate = 44100, duration = frameCount / fps;
  if (duration * sampleRate > 44100 * 600) throw new Error('Audio export is limited to ten minutes per render.');
  const decoder = new AudioContextType({ sampleRate });
  try {
    const decoded = new Map();
    for (const { asset } of audioClips) {
      if (decoded.has(asset.id)) continue;
      const encoded = asset.dataUrl.split(',', 2)[1] || '';
      const binary = atob(encoded), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      try { decoded.set(asset.id, await decoder.decodeAudioData(bytes.buffer)); }
      catch (error) { window.jupiterToast(`Skipped audio that cannot be mixed: ${asset.name}`); console.warn('Audio export skipped an unsupported asset.', error); }
    }
    const offline = new OfflineAudioContextType(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
    const compressor = offline.createDynamicsCompressor(); compressor.threshold.value = -4; compressor.ratio.value = 6; compressor.connect(offline.destination);
    for (const { clip, asset } of audioClips) {
      const start = clipStartFrame(clip.id) / fps;
      const buffer = decoded.get(asset.id);
      if (!buffer) continue;
      const clipDuration = Math.min(clip.durationFrames / fps, duration - start);
      if (clipDuration <= 0) continue;
      const source = offline.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = buffer.duration;
      source.connect(compressor);
      const sourceOffset = ((((Number(clip.sourceOffsetFrames) || 0) / fps) % buffer.duration) + buffer.duration) % buffer.duration;
      source.start(start, sourceOffset, clipDuration);
    }
    return audioBufferToWavBase64(await offline.startRendering());
  } finally { await decoder.close().catch(() => {}); }
}
function audioDuration(dataUrl) {
  return new Promise(resolve => {
    const audio = new Audio(); audio.preload = 'metadata';
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 5);
    audio.onerror = () => resolve(5); audio.src = dataUrl;
  });
}
const waveformLoads = new Map();
async function computeAudioWaveform(dataUrl) {
  const AudioContextType = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextType) return null;
  const encoded = String(dataUrl || '').split(',', 2)[1] || '';
  if (!encoded || encoded.length > 64 * 1024 * 1024) return null;
  let context;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    context = new AudioContextType();
    const buffer = await context.decodeAudioData(bytes.buffer);
    const bins = Math.min(900, Math.max(120, Math.ceil(buffer.duration * 36)));
    const peaks = new Array(bins).fill(0);
    for (let bin = 0; bin < bins; bin++) {
      const start = Math.floor(bin * buffer.length / bins);
      const end = Math.max(start + 1, Math.floor((bin + 1) * buffer.length / bins));
      let peak = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(samples[i] || 0));
      }
      peaks[bin] = Math.round(peak * 1000) / 1000;
    }
    return peaks;
  } catch (error) {
    console.debug('Audio waveform decode is unavailable for this media.', error);
    return null;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
async function ensureAudioWaveform(asset) {
  if (asset?.type !== 'audio' || Array.isArray(asset.waveform) || asset.waveformUnavailable) return asset?.waveform || null;
  if (waveformLoads.has(asset.id)) return waveformLoads.get(asset.id);
  const task = computeAudioWaveform(asset.dataUrl).then(peaks => {
    if (peaks?.length) {
      asset.waveform = peaks;
      app.renderTimeline();
      return peaks;
    }
    asset.waveformUnavailable = true;
    return null;
  }).finally(() => waveformLoads.delete(asset.id));
  waveformLoads.set(asset.id, task);
  return task;
}
async function resolveAudioDuration(dataUrl, sourcePath = null) {
  if (tauriMode && sourcePath) {
    try {
      const probe = await invoke('probe_media', { path: sourcePath });
      if (Number.isFinite(probe.duration) && probe.duration > 0) return probe.duration;
    } catch (error) {
      console.warn('FFprobe could not read audio metadata; using browser metadata instead.', error);
    }
  }
  return audioDuration(dataUrl);
}

function setMediaImportStatus(text) { const status = $('#media-import-status'); if (status) status.textContent = text; }

function activateInspectorTab(tab) {
  app.project.inspectorTab = tab;
  $$('[data-inspector-tab]').forEach(button => {
    const active = button.dataset.inspectorTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#inspector-values').classList.toggle('hidden', tab !== 'values');
  $('#inspector-media').classList.toggle('hidden', tab !== 'media');
}

async function importFiles(fileList, autoInsert = false) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  let imported = 0;
  let undoPushed = false;
  const batchKeys = new Set();
  setMediaImportStatus(`IMPORTING 0/${files.length}`);
  for (const [fileIndex, file] of files.entries()) {
    const type = detectMediaKind(file.name, file.type);
    if (!type) {
      window.jupiterToast(`Unsupported media: ${file.name}`);
      continue;
    }
    const sourceKey = `${file.name.toLowerCase()}|${file.size}|${file.lastModified}`;
    if (batchKeys.has(sourceKey) || app.project.assets.some(asset => asset.sourceKey === sourceKey)) {
      window.jupiterToast(`Already in Media: ${file.name}`);
      continue;
    }
    batchKeys.add(sourceKey);
    setMediaImportStatus(`IMPORTING ${fileIndex + 1}/${files.length}`);
    try {
      const dataUrl = await fileToDataUrl(file);
      const mime = mediaMime(file.name, file.type, type);
      const duration = type === 'audio' ? await resolveAudioDuration(dataUrl) : null;
      const asset = {
        id: makeId('asset'), name: file.name, type, mime, dataUrl,
        width: 0, height: 0, duration, sourceKey,
      };
      if (type === 'image') {
        const decoded = await loadImageAsset(asset);
        if (!decoded) throw new Error('The image preview could not be decoded.');
        asset.width = decoded.naturalWidth; asset.height = decoded.naturalHeight;
      }
      if (!undoPushed) { pushUndo('Import media'); undoPushed = true; }
      app.project.assets.push(asset);
      app.project.selectedAssetId = asset.id;
      if (autoInsert) addClip(asset.id);
      imported += 1;
    } catch (error) {
      window.jupiterToast(`Couldn't import ${file.name}: ${error.message || error}`);
    }
  }
  setMediaImportStatus(imported ? `${imported} ADDED` : 'READY');
  if (imported) {
    activateInspectorTab(autoInsert ? 'values' : 'media');
    app.renderAll();
    window.jupiterToast(`${imported} media item${imported === 1 ? '' : 's'} imported.`);
  }
}

async function importNativePaths(paths, autoInsert = false) {
  const list = [...new Set((paths || []).filter(Boolean))];
  if (!list.length) return;
  let imported = 0;
  let undoPushed = false;
  const batchPaths = new Set();
  setMediaImportStatus(`IMPORTING 0/${list.length}`);
  for (const [pathIndex, path] of list.entries()) {
    try {
      const pathKey = path.toLowerCase();
      if (batchPaths.has(pathKey) || app.project.assets.some(asset => asset.sourcePath?.toLowerCase() === pathKey)) {
        window.jupiterToast(`Already in Media: ${path.split(/[\\/]/).pop()}`);
        continue;
      }
      batchPaths.add(pathKey);
      setMediaImportStatus(`IMPORTING ${pathIndex + 1}/${list.length}`);
      const assetData = await invoke('read_asset', { path });
      const type = detectMediaKind(assetData.name, assetData.mime);
      if (!type) { window.jupiterToast(`Unsupported media: ${assetData.name}`); continue; }
      const mime = mediaMime(assetData.name, assetData.mime, type);
      const encoded = nativeAssetBase64(assetData);
      const dataUrl = `data:${mime};base64,${encoded}`;
      const duration = type === 'audio' ? await resolveAudioDuration(dataUrl, path) : null;
      const asset = { id: makeId('asset'), name: assetData.name, type, mime, dataUrl, width: 0, height: 0, duration, sourcePath: path };
      if (type === 'image') {
        const decoded = await loadImageAsset(asset);
        if (!decoded) throw new Error('The image preview could not be decoded.');
        asset.width = decoded.naturalWidth; asset.height = decoded.naturalHeight;
      }
      if (!undoPushed) { pushUndo('Import media'); undoPushed = true; }
      app.project.assets.push(asset);
      app.project.selectedAssetId = asset.id;
      if (autoInsert) addClip(asset.id);
      imported += 1;
    } catch (error) {
      window.jupiterToast(`Couldn't import ${path.split(/[\\/]/).pop()}: ${String(error).slice(0, 120)}`);
    }
  }
  setMediaImportStatus(imported ? `${imported} ADDED` : 'READY');
  if (imported) {
    activateInspectorTab(autoInsert ? 'values' : 'media');
    app.renderAll();
    window.jupiterToast(`${imported} media item${imported === 1 ? '' : 's'} imported.`);
  }
}

async function openMediaPicker() {
  if (mediaImportBusy) return;
  mediaImportBusy = true;
  const button = $('#media-import-button');
  if (button) { button.disabled = true; button.textContent = 'Opening…'; }
  try {
    if (tauriMode) {
      try {
        const selected = await open({
          multiple: true,
          directory: false,
          filters: [
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'svg', 'ico'] },
            { name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'wma', 'mid', 'midi'] },
            { name: 'All supported media', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'svg', 'ico', 'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'wma', 'mid', 'midi'] },
          ],
        });
        const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
        if (paths.length) await importNativePaths(paths, false);
      } catch (nativePickerError) {
        console.error('Native media picker failed; opening the WebView file picker.', nativePickerError);
        window.jupiterToast('Native picker unavailable. Opening the standard file picker…');
        $('#media-input').click();
      }
    } else {
      $('#media-input').click();
    }
  } catch (error) {
    window.jupiterToast(`Media picker failed: ${error.message || error}`);
  } finally {
    mediaImportBusy = false;
    if (button) { button.disabled = false; button.textContent = '＋ Add media'; }
  }
}

async function refreshFfmpegStatus() {
  const status = $('#ffmpeg-status');
  if (!status) return;
  if (!tauriMode) { status.textContent = 'DESKTOP CODEC'; return; }
  try {
    const info = await invoke('ffmpeg_status');
    status.textContent = info.available ? `FFMPEG READY${info.ffprobeAvailable ? ' · PROBE' : ''}` : 'FFMPEG NOT FOUND';
    status.title = info.available ? `FFmpeg: ${info.ffmpegPath}` : 'Run npm run setup:ffmpeg to install the bundled codec runtime.';
  } catch {
    status.textContent = 'FFMPEG CHECK FAILED';
  }
}

function renderMedia() {
  const container = $('#media-list');
  $('#media-count').textContent = String(app.project.assets.length);
  const inlineCount = $('#media-count-inline'); if (inlineCount) inlineCount.textContent = String(app.project.assets.length);
  if (!app.project.assets.length) {
    container.innerHTML = '<div class="media-empty media-import-prompt" id="media-import-prompt" role="button" tabindex="0"><span class="media-plus">＋</span><strong>Import media</strong><small>Click, double-click or drop files here</small></div>';
    return;
  }
  container.innerHTML = '';
  for (const asset of app.project.assets) {
    const card = document.createElement('div');
    card.className = `media-card${asset.id === app.project.selectedAssetId ? ' selected' : ''}`;
    card.draggable = false; card.dataset.assetId = asset.id;
    const thumb = document.createElement('div'); thumb.className = 'media-thumb';
    if (asset.type === 'image') {
      const img = document.createElement('img'); img.src = asset.dataUrl; img.alt = ''; img.draggable = false; thumb.appendChild(img);
    } else {
      thumb.textContent = '♫';
    }
    const name = document.createElement('strong'); name.textContent = asset.name;
    const meta = document.createElement('small');
    meta.textContent = asset.type === 'image' ? `${asset.width} × ${asset.height}` : `${asset.duration?.toFixed(1) ?? '—'} sec`;
    card.append(thumb, name, meta);
    card.addEventListener('click', event => {
      if (suppressMediaClick) { event.preventDefault(); event.stopPropagation(); suppressMediaClick = false; return; }
      app.project.selectedAssetId = asset.id;
      app.project.selectedClipId = null;
      app.project.selectedNodeId = null;
      activateInspectorTab('media');
      app.renderInspector(); renderMedia();
    });
    card.addEventListener('dblclick', () => addClip(asset.id));
    container.appendChild(card);
  }
}

function localFrameFor(clip) {
  const timelineFrame = Math.max(0, Math.min(clip.durationFrames - 1, app.project.currentFrame - clipStartFrame(clip.id)));
  const sourceFrame = timelineFrame + (Number(clip.sourceOffsetFrames) || 0);
  const loopDuration = Math.max(0, Number(clip.loopDurationFrames) || 0);
  return loopDuration ? ((sourceFrame % loopDuration) + loopDuration) % loopDuration : sourceFrame;
}
function hasNodeKey(node, frame) { return !!node?.keys?.some(key => key.frame === frame); }
function hasTransformKey(clip, property, frame) { return !!clip?.transform?.keys?.[property]?.some(key => key.frame === frame); }

function togglePropertyKey(clip, { node = null, property = null }) {
  if (!clip) return;
  const start = clipStartFrame(clip.id);
  const frame = localFrameFor(clip);
  pushUndo('Toggle keyframe');
  if (node) {
    const index = node.keys?.findIndex(key => key.frame === frame) ?? -1;
    if (index >= 0) node.keys.splice(index, 1);
    else {
      const pose = evaluateNode(node, frame);
      setNodePose(clip, node.id, pose, app.project.currentFrame, start);
    }
    app.project.selectedNodeId = node.id;
    app.project.graphProperty = 'node-x';
  } else if (property) {
    const keys = clip.transform?.keys?.[property] || [];
    const index = keys.findIndex(key => key.frame === frame);
    if (index >= 0) keys.splice(index, 1);
    else {
      const transform = evaluateClipTransform(clip, frame);
      setClipTransformValue(clip, property, transform[property], app.project.currentFrame, start);
    }
    app.project.graphProperty = property;
  }
  app.renderAll();
}

function propertyField(label, value, key, options = {}) {
  const row = document.createElement('div'); row.className = 'property-row';
  const caption = document.createElement('label'); caption.textContent = label;
  const input = document.createElement('input'); input.type = options.type || 'number'; input.value = value ?? ''; input.step = options.step || '0.01';
  if (options.min != null) input.min = String(options.min);
  if (options.max != null) input.max = String(options.max);
  input.addEventListener('change', () => options.onChange(Number(input.value), key));
  row.append(caption, input);
  if (options.onReset) {
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'property-reset';
    reset.textContent = '↺'; reset.title = `Reset ${label}`; reset.setAttribute('aria-label', `Reset ${label}`);
    reset.addEventListener('click', options.onReset); row.appendChild(reset);
  }
  if (options.keyAction) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = `key-toggle${options.keyActive ? ' active' : ''}`;
    button.title = options.keyActive ? 'Remove keyframe at playhead' : 'Add keyframe at playhead';
    button.textContent = '◆';
    button.addEventListener('click', options.keyAction);
    row.appendChild(button);
  } else {
    const spacer = document.createElement('span'); row.appendChild(spacer);
  }
  return row;
}

function rigHierarchySection(clip) {
  if (!clip?.rig?.nodes?.length) return null;
  const section = document.createElement('section'); section.className = 'property-section';
  const heading = document.createElement('h3'); heading.textContent = 'RIG HIERARCHY'; section.appendChild(heading);
  const tree = document.createElement('div'); tree.className = 'rig-tree';
  const parentByNode = new Map();
  for (const bone of clip.rig.bones || []) if (!parentByNode.has(bone.to)) parentByNode.set(bone.to, bone.from);
  const depthOf = id => { let depth = 0, cursor = id, seen = new Set(); while (parentByNode.has(cursor) && !seen.has(cursor)) { seen.add(cursor); cursor = parentByNode.get(cursor); depth++; } return Math.min(depth, 8); };
  for (const node of clip.rig.nodes) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = `rig-tree-item${node.id === app.project.selectedNodeId ? ' selected' : ''}`;
    button.style.paddingLeft = `${7 + depthOf(node.id) * 12}px`;
    const dot = document.createElement('span'); dot.className = 'joint-dot';
    const name = document.createElement('span'); name.textContent = node.name;
    button.append(dot, name);
    button.addEventListener('click', () => {
      app.project.selectedClipId = clip.id; app.project.selectedAssetId = clip.assetId;
      app.project.selectedNodeId = node.id; app.project.activeTool = 'node'; app.renderAll();
    });
    tree.appendChild(button);
  }
  section.appendChild(tree);
  return section;
}

function graphValues(clip, node, property) {
  const isNode = property.startsWith('node-') && node;
  if (isNode) {
    const axis = property.endsWith('y') ? 'y' : 'x';
    const keys = [...(node.keys || [])].sort((a, b) => a.frame - b.frame);
    const base = { frame: 0, [axis]: node[axis], interpolation: 'linear', __base: true };
    const points = keys.some(key => key.frame === 0) ? keys : [base, ...keys];
    return { axis, keys, points, isNode: true };
  }
  const axis = property;
  const value = evaluateClipTransform(clip, 0)[axis];
  const keys = [...(clip.transform?.keys?.[axis] || [])].sort((a, b) => a.frame - b.frame);
  const base = { frame: 0, value, interpolation: 'linear', __base: true };
  return { axis, keys, points: keys.some(key => key.frame === 0) ? keys : [base, ...keys], isNode: false };
}

function renderGraphEditor(parent, clip, node) {
  if (!clip) return;
  const section = document.createElement('section'); section.className = 'graph-editor';
  const heading = document.createElement('div'); heading.className = 'graph-heading';
  const title = document.createElement('strong'); title.textContent = 'VALUE GRAPH';
  const property = document.createElement('select'); property.id = 'graph-property';
  const graphOptions = node
    ? [['node-x', 'Joint X'], ['node-y', 'Joint Y']]
    : [['x', 'Position X'], ['y', 'Position Y'], ['rotation', 'Rotation'], ['scale', 'Scale'], ['opacity', 'Opacity']];
  if (!graphOptions.some(([value]) => value === app.project.graphProperty)) app.project.graphProperty = graphOptions[0][0];
  for (const [value, label] of graphOptions) { const option = document.createElement('option'); option.value = value; option.textContent = label; property.appendChild(option); }
  property.value = app.project.graphProperty;
  property.addEventListener('change', () => { app.project.graphProperty = property.value; app.renderInspector(); });
  heading.append(title, property);
  const interpolation = document.createElement('select'); interpolation.id = 'graph-interpolation';
  for (const [value, label] of [['linear', 'Linear'], ['ease', 'Ease'], ['hold', 'Hold']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; interpolation.appendChild(option); }
  const local = localFrameFor(clip);
  const source = graphValues(clip, node, property.value);
  const currentKey = source.keys.find(key => key.frame === local);
  interpolation.value = currentKey?.interpolation || 'linear';
  interpolation.disabled = !currentKey;
  interpolation.addEventListener('change', () => {
    const key = source.keys.find(item => item.frame === local);
    if (!key) return;
    pushUndo('Change interpolation'); key.interpolation = interpolation.value; app.renderAll();
  });
  heading.appendChild(interpolation);
  const canvas = document.createElement('canvas'); canvas.className = 'curve-canvas'; canvas.height = 300;
  const footer = document.createElement('div'); footer.className = 'graph-footer'; footer.textContent = 'DRAG KEY POINTS TO ADJUST TIME AND VALUE · DIAMONDS ARE KEYFRAMES';
  section.append(heading, canvas, footer); parent.appendChild(section);

  const drawGraph = () => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(180, Math.floor(rect.width));
    const height = Math.max(220, Math.floor(rect.height || 300)); const dpr = Math.min(2, window.devicePixelRatio || 1);
    const dark = document.body.classList.contains('dark-theme');
    const gridColor = dark ? '#3b4854' : '#e1e8ef';
    const axisColor = dark ? '#536371' : '#c8d3de';
    const labelColor = dark ? '#a4b2be' : '#74879a';
    const curveColor = dark ? '#8bb5d7' : '#6487a5';
    const basePointColor = dark ? '#27323d' : '#fff';
    const keyPointColor = dark ? '#78baff' : '#438fc9';
    const keyStrokeColor = dark ? '#add5f5' : '#3279b2';
    canvas.width = width * dpr; canvas.height = height * dpr;
    const c = canvas.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, width, height);
    const current = graphValues(clip, node, property.value);
    const values = current.points.map(point => Number(current.isNode ? point[current.axis] : point.value) || 0);
    let min = Math.min(...values), max = Math.max(...values);
    if (current.axis === 'opacity') { min = 0; max = 1; }
    else {
      if (Math.abs(max - min) < 1e-5) { min -= .5; max += .5; }
      const pad = Math.max((max - min) * .16, .08); min -= pad; max += pad;
    }
    const left = 48, right = width - 12, top = 15, bottom = height - 30;
    const maxFrame = Math.max(1, clip.durationFrames - 1);
    const px = frame => left + (Math.max(0, Math.min(maxFrame, frame)) / maxFrame) * (right - left);
    const py = value => bottom - ((value - min) / (max - min)) * (bottom - top);
    c.font = '10px Inter, system-ui, sans-serif';
    for (let i = 0; i <= 4; i++) {
      const y = top + (bottom - top) * i / 4;
      const value = max - (max - min) * i / 4;
      c.strokeStyle = i === 4 ? axisColor : gridColor; c.lineWidth = 1;
      c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke();
      c.fillStyle = labelColor;
      const label = current.axis === 'opacity' || current.axis === 'scale' ? `${Math.round(value * 100)}%` : Number(value.toFixed(Math.abs(max - min) < 10 ? 1 : 0)).toString();
      c.fillText(label, 3, y + 3);
    }
    for (let i = 0; i <= 4; i++) {
      const frame = Math.round(maxFrame * i / 4), x = px(frame);
      c.strokeStyle = gridColor; c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      c.fillStyle = labelColor; c.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      c.fillText(`${(frame / app.project.fps).toFixed(1)}s`, x, height - 8);
    }
    c.textAlign = 'left';
    const playX = px(localFrameFor(clip));
    c.save(); c.strokeStyle = '#e18a55'; c.fillStyle = '#e18a55'; c.lineWidth = 1.2; c.setLineDash([4, 3]);
    c.beginPath(); c.moveTo(playX, top); c.lineTo(playX, bottom); c.stroke(); c.setLineDash([]);
    c.beginPath(); c.moveTo(playX - 4, top - 6); c.lineTo(playX + 4, top - 6); c.lineTo(playX, top); c.closePath(); c.fill(); c.restore();
    const points = current.points.map(point => ({ frame: point.frame, value: Number(current.isNode ? point[current.axis] : point.value) || 0, source: point }));
    if (points.length) {
      c.beginPath(); c.moveTo(px(points[0].frame), py(points[0].value));
      for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1], next = points[i];
        if (previous.source.interpolation === 'hold') {
          c.lineTo(px(next.frame), py(previous.value)); c.lineTo(px(next.frame), py(next.value));
        } else if (previous.source.interpolation === 'ease') {
          const steps = 16;
          for (let step = 1; step <= steps; step++) {
            const t = step / steps, eased = t * t * (3 - 2 * t);
            c.lineTo(px(previous.frame + (next.frame - previous.frame) * t), py(previous.value + (next.value - previous.value) * eased));
          }
        } else c.lineTo(px(next.frame), py(next.value));
      }
      c.strokeStyle = curveColor; c.lineWidth = 1.5; c.stroke();
      for (const point of points) {
        const x = px(point.frame), y = py(point.value), size = point.source.__base ? 3 : 4.5;
        c.beginPath(); c.moveTo(x, y - size); c.lineTo(x + size, y); c.lineTo(x, y + size); c.lineTo(x - size, y); c.closePath();
        c.fillStyle = point.source.__base ? basePointColor : keyPointColor; c.fill(); c.strokeStyle = keyStrokeColor; c.lineWidth = 1.2; c.stroke();
      }
    }
    return { current, px, py, min, max, left, right, top, bottom, maxFrame };
  };
  drawGraph();
  const graphResize = new ResizeObserver(() => drawGraph()); graphResize.observe(canvas);
  let graphDrag = null;
  canvas.addEventListener('pointerdown', event => {
    const map = drawGraph();
    const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left, y = event.clientY - rect.top;
    let nearest = null, best = 10;
    for (const key of map.current.keys) {
      const distance = Math.hypot(map.px(key.frame) - x, map.py(Number(map.current.isNode ? key[map.current.axis] : key.value)) - y);
      if (distance < best) { best = distance; nearest = key; }
    }
    if (!nearest) return;
    pushUndo('Edit graph key');
    graphDrag = { key: nearest, map, rect };
    app.project.selectedGraphFrame = nearest.frame;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!graphDrag) return;
    const bounds = canvas.getBoundingClientRect();
    const x = Math.max(graphDrag.map.left, Math.min(graphDrag.map.right, event.clientX - bounds.left));
    const y = Math.max(graphDrag.map.top, Math.min(graphDrag.map.bottom, event.clientY - bounds.top));
    const frame = Math.round((x - graphDrag.map.left) / (graphDrag.map.right - graphDrag.map.left) * graphDrag.map.maxFrame);
    const value = graphDrag.map.max - ((y - graphDrag.map.top) / (graphDrag.map.bottom - graphDrag.map.top)) * (graphDrag.map.max - graphDrag.map.min);
    graphDrag.key.frame = frame;
    if (graphDrag.map.current.isNode) graphDrag.key[graphDrag.map.current.axis] = value;
    else graphDrag.key.value = value;
    const keys = graphDrag.map.current.keys; keys.sort((a, b) => a.frame - b.frame);
    app.project.currentFrame = clipStartFrame(clip.id) + frame;
    app.drawStage(); updateTimelinePlayhead(); drawGraph();
  });
  canvas.addEventListener('pointerup', () => { if (graphDrag) { graphDrag = null; app.renderAll(); } });
  canvas.addEventListener('pointercancel', () => { graphDrag = null; });
}

function renderInspector() {
  const tab = app.project.inspectorTab === 'media' ? 'media' : 'values';
  $$('[data-inspector-tab]').forEach(button => button.classList.toggle('active', button.dataset.inspectorTab === tab));
  $('#inspector-values').classList.toggle('hidden', tab !== 'values');
  $('#inspector-media').classList.toggle('hidden', tab !== 'media');
  const values = $('#inspector-values');
  const clip = findClip(app.project.selectedClipId);
  const asset = findAsset(app.project.selectedAssetId) || (clip ? findAsset(clip.assetId) : null);
  const node = clip?.rig?.nodes.find(item => item.id === app.project.selectedNodeId);
  values.innerHTML = '';
  const valuesLayout = document.createElement('div'); valuesLayout.className = 'values-layout';
  const controlsColumn = document.createElement('div'); controlsColumn.className = 'values-controls';
  const graphColumn = document.createElement('div'); graphColumn.className = 'values-graph';
  valuesLayout.append(controlsColumn, graphColumn); values.appendChild(valuesLayout);
  const keyNav = document.createElement('div'); keyNav.className = 'inspector-key-nav';
  keyNav.innerHTML = '<span>KEYFRAMES</span><div><button type="button" id="inspector-prev-key" title="Previous keyframe">◂◆</button><button type="button" id="inspector-next-key" title="Next keyframe">◆▸</button></div>';
  controlsColumn.appendChild(keyNav);
  keyNav.querySelector('#inspector-prev-key').addEventListener('click', () => navigateKeyframe(-1));
  keyNav.querySelector('#inspector-next-key').addEventListener('click', () => navigateKeyframe(1));

  if (node && clip) {
    const start = clipStartFrame(clip.id), local = localFrameFor(clip);
    const pos = evaluateNode(node, local);
    const rigSection = document.createElement('section'); rigSection.className = 'property-section';
    rigSection.innerHTML = '<h3>SELECTED JOINT</h3>';
    const nameRow = document.createElement('div'); nameRow.className = 'property-row';
    const nameLabel = document.createElement('label'); nameLabel.textContent = 'Joint name';
    const nameInput = document.createElement('input'); nameInput.type = 'text'; nameInput.value = node.name;
    const nameSpacer = document.createElement('span');
    nameInput.addEventListener('change', () => { pushUndo('Rename joint'); node.name = nameInput.value.trim() || 'Joint'; app.renderAll(); });
    nameRow.append(nameLabel, nameInput, nameSpacer); rigSection.appendChild(nameRow);
    const nodeKey = hasNodeKey(node, local);
    rigSection.append(propertyField('X position · %', (pos.x * 100).toFixed(1), 'x', {
      keyActive: nodeKey, keyAction: () => togglePropertyKey(clip, { node }),
      onChange: value => { if (!Number.isFinite(value)) return; pushUndo('Set joint X'); const next = { ...pos, x: value / 100 }; if (app.project.autoKey !== false || nodeKey) setNodePose(clip, node.id, next, app.project.currentFrame, start); else node.x = next.x; app.renderAll(); },
      onReset: () => { pushUndo('Reset joint X'); const next = { ...evaluateNode(node, local), x: node.x }; if (app.project.autoKey !== false || nodeKey) setNodePose(clip, node.id, next, app.project.currentFrame, start); else node.x = next.x; app.renderAll(); },
    }));
    rigSection.append(propertyField('Y position · %', (pos.y * 100).toFixed(1), 'y', {
      keyActive: nodeKey, keyAction: () => togglePropertyKey(clip, { node }),
      onChange: value => { if (!Number.isFinite(value)) return; pushUndo('Set joint Y'); const next = { ...pos, y: value / 100 }; if (app.project.autoKey !== false || nodeKey) setNodePose(clip, node.id, next, app.project.currentFrame, start); else node.y = next.y; app.renderAll(); },
      onReset: () => { pushUndo('Reset joint Y'); const next = { ...evaluateNode(node, local), y: node.y }; if (app.project.autoKey !== false || nodeKey) setNodePose(clip, node.id, next, app.project.currentFrame, start); else node.y = next.y; app.renderAll(); },
    }));
    const actionRow = document.createElement('div'); actionRow.className = 'property-actions';
    const deleteButton = document.createElement('button'); deleteButton.className = 'small-action'; deleteButton.textContent = 'Delete joint';
    deleteButton.addEventListener('click', () => { pushUndo('Delete joint'); deleteNode(clip, node.id); app.renderAll(); });
    const selectTool = document.createElement('button'); selectTool.className = 'small-action'; selectTool.textContent = 'Node tool (N)'; selectTool.addEventListener('click', () => { app.project.activeTool = 'node'; app.renderAll(); });
    actionRow.append(deleteButton, selectTool); rigSection.appendChild(actionRow);
    controlsColumn.appendChild(rigSection);
  }

  if (clip && asset?.type === 'image') {
    const start = clipStartFrame(clip.id), localFrame = localFrameFor(clip);
    const transform = evaluateClipTransform(clip, localFrame);
    const section = document.createElement('section'); section.className = 'property-section transform-section';
    section.innerHTML = '<div class="property-heading"><h3>TRANSFORM</h3><button type="button" class="reset-all">Reset all</button></div>';
    section.querySelector('.reset-all').addEventListener('click', () => {
      pushUndo('Reset transform');
      const defaults = { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 };
      if (app.project.autoKey !== false) {
        for (const [property, value] of Object.entries(defaults)) {
          setClipTransformValue(clip, property, value, app.project.currentFrame, start);
        }
      } else {
        for (const [property, value] of Object.entries(defaults)) {
          if (hasTransformKey(clip, property, localFrame)) setClipTransformValue(clip, property, value, app.project.currentFrame, start);
          else clip.transform[property] = value;
        }
      }
      app.renderAll();
    });
    const transformFields = [
      ['Position X', 'x', transform.x, '0.1'], ['Position Y', 'y', transform.y, '0.1'],
      ['Rotation (°)', 'rotation', transform.rotation, '1'], ['Scale (%)', 'scale', transform.scale, '1'], ['Opacity (%)', 'opacity', transform.opacity, '1'],
    ];
    for (const [label, key, value, step] of transformFields) {
      const percent = key === 'opacity' || key === 'scale';
      const shownValue = percent ? Number(value * 100).toFixed(0) : Number(value).toFixed(key === 'x' || key === 'y' ? 1 : 1);
      section.append(propertyField(label, shownValue, key, {
        min: percent ? 0 : undefined, max: percent ? 10000 : undefined, step: percent ? '1' : step,
        keyActive: hasTransformKey(clip, key, localFrame),
        keyAction: () => togglePropertyKey(clip, { property: key }),
        onChange: next => {
          if (!Number.isFinite(next)) return;
          const normalized = percent ? next / 100 : next;
          const clamped = key === 'scale' ? Math.max(.01, normalized) : key === 'opacity' ? Math.max(0, Math.min(1, normalized)) : next;
          pushUndo('Edit artwork transform');
          if (app.project.autoKey !== false || hasTransformKey(clip, key, localFrame)) setClipTransformValue(clip, key, clamped, app.project.currentFrame, start);
          else clip.transform[key] = clamped;
          app.renderAll();
        },
        onReset: () => {
          const defaults = { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 };
          pushUndo(`Reset ${label}`);
          if (app.project.autoKey !== false || hasTransformKey(clip, key, localFrame)) setClipTransformValue(clip, key, defaults[key], app.project.currentFrame, start);
          else clip.transform[key] = defaults[key];
          app.renderAll();
        },
      }));
    }
    controlsColumn.append(section);
    const hierarchy = rigHierarchySection(clip); if (hierarchy) controlsColumn.appendChild(hierarchy);
    renderGraphEditor(graphColumn, clip, node || null);
  } else if (!node && asset) {
    const section = document.createElement('section'); section.className = 'property-section';
    section.innerHTML = `<h3>MEDIA DETAILS</h3><div class="media-detail">${asset.type === 'image' ? `<img src="${asset.dataUrl}" alt="">` : '<div class="media-thumb">♫</div>'}<div><strong></strong><span></span></div></div>`;
    section.querySelector('strong').textContent = asset.name;
    section.querySelector('span').textContent = asset.type === 'image' ? `${asset.width} × ${asset.height} px` : `${asset.duration?.toFixed(1) ?? '—'} seconds`;
    controlsColumn.appendChild(section);
    graphColumn.innerHTML = '<div class="graph-empty">Select a timeline clip to edit animation curves.</div>';
  } else if (!node && !asset) {
    controlsColumn.innerHTML += '<div class="inspector-empty">Select an artwork layer or joint.</div>'; graphColumn.innerHTML = '<div class="graph-empty">Animation curves appear here.</div>';
  }

  // IMPORTANT: only touch the dedicated detail slot. The rest of #inspector-media
  // (Add button, #media-list) is static markup that renderMedia() owns; wiping the
  // whole panel used to destroy the list after the first import.
  const detail = $('#media-detail');
  detail.innerHTML = '';
  if (asset) {
    const section = document.createElement('section'); section.className = 'property-section';
    section.innerHTML = `<h3>MEDIA SOURCE</h3><div class="media-detail">${asset.type === 'image' ? '<img alt="">' : '<div class="media-thumb">♫</div>'}<div><strong></strong><span></span></div></div>`;
    const preview = section.querySelector('img'); if (preview) preview.src = asset.dataUrl;
    section.querySelector('strong').textContent = asset.name;
    section.querySelector('span').textContent = `${asset.mime} · ${asset.type === 'image' ? `${asset.width} × ${asset.height}` : `${asset.duration?.toFixed(1) ?? '—'} sec`}`;
    detail.appendChild(section);
  }
}

function navigateKeyframe(direction) {
  const clip = findClip(app.project.selectedClipId) || getActiveClip()?.clip;
  if (!clip) { window.jupiterToast('Select an animated clip first.'); return; }
  const start = clipStartFrame(clip.id);
  let frames = [];
  const selectedNode = clip.rig?.nodes.find(item => item.id === app.project.selectedNodeId);
  if (selectedNode) frames = (selectedNode.keys || []).map(key => key.frame);
  else {
    for (const property of TRANSFORM_PROPERTIES) {
      frames.push(...(clip.transform?.keys?.[property] || []).map(key => key.frame));
    }
  }
  frames = [...new Set(frames)].sort((a, b) => a - b);
  const local = Math.max(0, app.project.currentFrame - start);
  const next = direction < 0 ? frames.filter(frame => frame < local).at(-1) : frames.find(frame => frame > local);
  if (next == null) { window.jupiterToast(direction < 0 ? 'No previous keyframe.' : 'No next keyframe.'); return; }
  seekFrame(start + next);
}

function renderToolbar() {
  $$('[data-tool]').forEach(button => button.classList.toggle('active', button.dataset.tool === app.project.activeTool));
  const labels = { select: 'SELECT', move: 'MOVE ARTWORK', rig: 'RIG', node: 'NODE' };
  $('#tool-status').textContent = labels[app.project.activeTool] || 'SELECT MODE';
  $('#stage-mode-label').textContent = ({ select: 'SELECT · ARTWORK OR JOINT', move: 'MOVE · ARTWORK ONLY', rig: 'RIG · DRAW BONES', node: 'NODE · JOINTS ONLY' })[app.project.activeTool] || 'SELECT';
  $('#undo-button').disabled = !app.history.length;
  $('#redo-button').disabled = !app.future.length;
}

function renderAll() {
  setProjectName(app.project.name);
  renderMedia(); renderInspector(); renderToolbar(); refreshTimeline(); refreshStage();
  const tab = app.project.inspectorTab === 'media' ? 'media' : 'values';
  $$('[data-inspector-tab]').forEach(button => button.classList.toggle('active', button.dataset.inspectorTab === tab));
  $('#inspector-values').classList.toggle('hidden', tab !== 'values');
  $('#inspector-media').classList.toggle('hidden', tab !== 'media');
}

function addKeyframeAtPlayhead() {
  const clip = findClip(app.project.selectedClipId) || getActiveClip()?.clip;
  const asset = clip && findAsset(clip.assetId);
  if (!clip || asset?.type !== 'image') { window.jupiterToast('Select an image clip first.'); return; }
  const start = clipStartFrame(clip.id);
  const localFrame = Math.max(0, Math.min(clip.durationFrames - 1, app.project.currentFrame - start));
  pushUndo('Insert keyframe');
  const selectedNode = clip.rig?.nodes.find(node => node.id === app.project.selectedNodeId);
  if (selectedNode) {
    const pose = evaluateNode(selectedNode, localFrame);
    setNodePose(clip, selectedNode.id, pose, app.project.currentFrame, start);
  } else {
    for (const node of clip.rig?.nodes || []) {
      const pose = evaluateNode(node, localFrame);
      setNodePose(clip, node.id, pose, app.project.currentFrame, start);
    }
  }
  const transform = evaluateClipTransform(clip, localFrame);
  for (const property of TRANSFORM_PROPERTIES) setClipTransformValue(clip, property, transform[property], app.project.currentFrame, start);
  app.project.selectedClipId = clip.id;
  app.project.selectedAssetId = asset.id;
  app.renderAll();
  window.jupiterToast(`Keyframe${selectedNode ? ' added for ' + selectedNode.name : 's added'} at frame ${localFrame}.`);
}

function stopAudio() {
  for (const audio of currentAudio.values()) { try { audio.pause(); audio.currentTime = 0; } catch {} }
  currentAudio.clear();
}
function syncAudio(frame) {
  const wanted = new Map();
  for (const track of app.project.tracks.filter(t => t.type === 'audio')) {
    let cursor = Math.max(0, Number(track.startFrame) || 0);
    for (const clipId of track.clipIds) {
      const clip = findClip(clipId); const asset = clip && findAsset(clip.assetId);
      if (!clip || !asset) continue;
      if (frame >= cursor && frame < cursor + clip.durationFrames) wanted.set(clip.id, { clip, asset, local: frame - cursor });
      cursor += clip.durationFrames;
    }
  }
  for (const [id, player] of currentAudio) if (!wanted.has(id)) { player.pause(); currentAudio.delete(id); }
  for (const [id, item] of wanted) {
    if (currentAudio.has(id)) continue;
    const audio = new Audio(item.asset.dataUrl);
    audio.loop = true;
    const fps = app.project.fps;
    const sourceFrames = Math.max(1, Math.round((Number(item.asset.duration) || item.clip.loopDurationFrames / fps || item.clip.durationFrames / fps) * fps));
    const sourceFrame = ((((Number(item.clip.sourceOffsetFrames) || 0) + item.local) % sourceFrames) + sourceFrames) % sourceFrames;
    audio.currentTime = sourceFrame / fps;
    audio.volume = 1; audio.play().catch(() => {}); currentAudio.set(id, audio);
  }
}

function pausePlayback() {
  app.project.playing = false;
  cancelAnimationFrame(playbackRequest); playbackRequest = 0;
  stopAudio();
  $('#play-button').classList.remove('playing'); $('#play-button').textContent = '▶';
}
async function exportVideo() {
  if (!tauriMode) { window.jupiterToast('Video export is available in the Jupiter desktop app.'); return; }
  if (!app.project.clips.length) { window.jupiterToast('Add artwork to the timeline before exporting.'); return; }
  let outputPath;
  try {
    outputPath = await save({
      defaultPath: `${app.project.name || 'Jupiter'}.mp4`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
  } catch (error) { window.jupiterToast(`Could not open export dialog: ${error?.message || error}`); return; }
  if (!outputPath) return;
  if (!outputPath.toLowerCase().endsWith('.mp4')) outputPath += '.mp4';

  pausePlayback();
  const button = $('#export-placeholder');
  const originalFrame = app.project.currentFrame;
  const originalSelection = { clipId: app.project.selectedClipId, nodeId: app.project.selectedNodeId, tool: app.project.activeTool };
  const frameCount = getSequenceDuration();
  let framesDirectory = null;
  button.disabled = true;
  button.title = 'Rendering video…';
  app.project.selectedClipId = null; app.project.selectedNodeId = null; app.project.activeTool = 'select';
  window.jupiterToast(`Rendering ${frameCount} frames for export…`);
  try {
    framesDirectory = await invoke('create_export_frames_directory');
    const audioBase64 = await renderProjectAudio(frameCount, app.project.fps);
    const audioPath = audioBase64
      ? await invoke('write_export_audio', { framesDirectory, dataBase64: audioBase64 })
      : null;
    const stageCanvas = $('#stage-canvas');
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = stageCanvas.width + (stageCanvas.width % 2);
    exportCanvas.height = stageCanvas.height + (stageCanvas.height % 2);
    const context = exportCanvas.getContext('2d');
    for (let frame = 0; frame < frameCount; frame++) {
      app.project.currentFrame = frame;
      refreshStage();
      renderStageNow();
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
      context.drawImage(stageCanvas, 0, 0);
      const base64 = exportCanvas.toDataURL('image/png').split(',', 2)[1];
      await invoke('write_export_frame', { framesDirectory, frameNumber: frame, dataBase64: base64 });
      if (frame % Math.max(1, Math.floor(frameCount / 20)) === 0) {
        button.title = `Rendering frame ${frame + 1} of ${frameCount}…`;
      }
    }
    const message = await invoke('export_png_sequence_to_mp4', {
      framesDirectory, outputPath, fps: app.project.fps, audioPath,
    });
    const exportName = outputPath.replaceAll('\\', '/').split('/').pop();
    window.jupiterToast(`Export complete: ${exportName}`);
    console.info(message);
  } catch (error) {
    window.jupiterToast(`Export failed: ${error?.message || error}`);
  } finally {
    app.project.currentFrame = originalFrame;
    app.project.selectedClipId = originalSelection.clipId;
    app.project.selectedNodeId = originalSelection.nodeId;
    app.project.activeTool = originalSelection.tool;
    app.renderAll();
    if (framesDirectory) invoke('remove_export_frames_directory', { framesDirectory }).catch(() => {});
    button.disabled = false;
    button.title = 'Export video';
  }
}
function playPlayback() {
  if (app.project.playing) { pausePlayback(); return; }
  if (!app.project.clips.length) { window.jupiterToast('Add media to the timeline before playing.'); return; }
  if (app.project.currentFrame >= getSequenceDuration() - 1) app.project.currentFrame = 0;
  app.project.playing = true;
  playbackAnchor = performance.now(); playbackStartFrame = app.project.currentFrame;
  $('#play-button').classList.add('playing'); $('#play-button').textContent = 'Ⅱ';
  function tick(now) {
    if (!app.project.playing) return;
    const elapsed = (now - playbackAnchor) / 1000;
    const next = playbackStartFrame + Math.floor(elapsed * app.project.fps);
    if (next >= getSequenceDuration()) {
      app.project.currentFrame = getSequenceDuration() - 1;
      pausePlayback(); app.drawStage(); updateTimelinePlayhead(); return;
    }
    if (next !== app.project.currentFrame) {
      app.project.currentFrame = next;
      syncAudio(next); app.drawStage(); updateTimelinePlayhead();
    }
    playbackRequest = requestAnimationFrame(tick);
  }
  playbackRequest = requestAnimationFrame(tick);
}

async function saveProject(saveAs = false) {
  const content = JSON.stringify({ ...app.project, lastProjectPath: undefined }, null, 2);
  try {
    if (tauriMode) {
      let path = projectPath;
      if (!path || saveAs) path = await save({ defaultPath: `${app.project.name.replace(/[\\/:*?"<>|]/g, '_')}.jupiter`, filters: [{ name: 'Jupiter Project', extensions: ['jupiter'] }] });
      if (!path) return;
      await invoke('save_project', { path, contents: content });
      projectPath = path;
    } else {
      const blob = new Blob([content], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${app.project.name || 'Untitled'}.jupiter`; anchor.click(); URL.revokeObjectURL(url);
    }
    app.dirty = false; window.jupiterToast('Project saved.');
  } catch (error) { window.jupiterToast(`Save failed: ${error}`); }
}

function validateProject(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.assets) || !Array.isArray(data.tracks) || !Array.isArray(data.clips)) throw new Error('This file is not a valid Jupiter project.');
  data.fps = Number(data.fps) || 24;
  data.autoKey = true;
  data.tracks.forEach(track => { track.clipIds ??= []; track.startFrame = Math.max(0, Number(track.startFrame) || 0); });
  const counts = { video: 0, audio: 0 };
  const normalizedTracks = [];
  for (const track of data.tracks) {
    const type = track.type === 'audio' ? 'audio' : 'video';
    if (counts[type] >= 3) continue;
    counts[type] += 1;
    track.type = type;
    track.clipIds ??= [];
    track.code = `${type === 'video' ? 'V' : 'A'}${counts[type]}`;
    if (!track.name || /^([VA])\d+$/.test(track.name)) track.name = type === 'video' ? (counts[type] === 1 ? 'Main video' : `Video ${counts[type]}`) : (counts[type] === 1 ? 'Main audio' : `Audio ${counts[type]}`);
    normalizedTracks.push(track);
  }
  data.tracks = normalizedTracks;
  for (const type of ['video', 'audio']) {
    if (!data.tracks.some(track => track.type === type)) {
      const index = counts[type] + 1;
      data.tracks.push({ id: makeId('track'), name: `${type === 'video' ? 'V' : 'A'}${index}`, code: `${type === 'video' ? 'V' : 'A'}${index}`, type, clipIds: [] });
    }
  }
  data.clips.forEach(clip => {
    clip.durationFrames = Math.max(1, Number(clip.durationFrames) || data.fps * 5);
    const clipAsset = data.assets.find(asset => asset.id === clip.assetId);
    const defaultLoop = clipAsset?.type === 'audio' && clipAsset.duration
      ? Math.max(1, Math.round(clipAsset.duration * data.fps))
      : clip.durationFrames;
    clip.loopDurationFrames = Math.max(1, Number(clip.loopDurationFrames) || defaultLoop);
    clip.sourceOffsetFrames = Number.isFinite(Number(clip.sourceOffsetFrames)) ? Number(clip.sourceOffsetFrames) : 0;
    clip.transform ??= { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
    clip.transform.keys ??= {};
    for (const property of TRANSFORM_PROPERTIES) clip.transform.keys[property] ??= [];
    if (clip.rig) { clip.rig.nodes ??= []; clip.rig.bones ??= []; clip.rig.nodes.forEach(node => { node.keys ??= []; }); }
  });
  return data;
}
async function openProject() {
  try {
    if (tauriMode) {
      const path = await open({ multiple: false, filters: [{ name: 'Jupiter Project', extensions: ['jupiter', 'json'] }] });
      if (!path) return;
      const raw = await invoke('load_project', { path });
      const data = validateProject(JSON.parse(raw));
      app.project = data; projectPath = path; app.dirty = false; app.history.length = 0; app.future.length = 0; app.imageCache.clear();
    } else {
      $('#project-input').click(); return;
    }
    for (const asset of app.project.assets) if (asset.type === 'image') await loadImageAsset(asset);
    app.renderAll(); window.jupiterToast('Project opened.');
  } catch (error) { window.jupiterToast(`Open failed: ${error.message || error}`); }
}
function openProjectFromFile(file) {
  const reader = new FileReader(); reader.onload = async () => {
    try {
      app.project = validateProject(JSON.parse(String(reader.result))); projectPath = null; app.dirty = false; app.history.length = 0; app.future.length = 0; app.imageCache.clear();
      for (const asset of app.project.assets) if (asset.type === 'image') await loadImageAsset(asset);
      app.renderAll(); window.jupiterToast('Project opened.');
    } catch (error) { window.jupiterToast(`Could not open project: ${error.message}`); }
  }; reader.readAsText(file);
}
function newProject() {
  if (app.dirty && !confirm('Discard unsaved changes and create a new project?')) return;
  pausePlayback(); app.project = createProject(); projectPath = null; app.history.length = 0; app.future.length = 0; app.imageCache.clear(); app.renderAll();
}

function closeMenu() { $('#project-menu').classList.add('hidden'); }
function runMenuAction(action) {
  closeMenu();
  switch (action) {
    case 'new-project': newProject(); break;
    case 'open-project': openProject(); break;
    case 'save-project': saveProject(false); break;
    case 'save-as': saveProject(true); break;
    case 'import-png': $('#png-input').click(); break;
    case 'import-audio': $('#audio-input').click(); break;
    case 'close-project': newProject(); break;
    case 'exit': if (tauriMode) getCurrentWindow().close(); else window.jupiterToast('Close this browser tab to exit.'); break;
  }
}

// Global application state hooks consumed by the small focused modules.
app.renderMedia = renderMedia;
app.renderInspector = renderInspector;
app.renderToolbar = renderToolbar;
app.renderTimeline = refreshTimeline;
app.drawStage = refreshStage;
app.loadAudioWaveform = ensureAudioWaveform;
app.pausePlayback = pausePlayback;
app.renderAll = renderAll;

function toggleInspector() {
  const collapsed = $('#inspector-panel').classList.toggle('collapsed');
  $('.editor-layout').classList.toggle('inspector-collapsed', collapsed);
  $('#toggle-inspector').textContent = collapsed ? '‹' : '›';
  $('#toggle-inspector').title = collapsed ? 'Show inspector' : 'Collapse inspector';
  $('#toggle-inspector').setAttribute('aria-label', collapsed ? 'Show inspector' : 'Collapse inspector');
  $('#toggle-inspector').setAttribute('aria-expanded', String(!collapsed));
}
function toggleTools() {
  const collapsed = $('.editor-layout').classList.toggle('tools-collapsed');
  $('#toggle-tools').textContent = collapsed ? '›' : '‹';
  $('#toggle-tools').title = collapsed ? 'Show tools' : 'Collapse tools';
  $('#toggle-tools').setAttribute('aria-label', collapsed ? 'Show tools' : 'Collapse tools');
}

function applyTheme(dark, persist = false) {
  document.body.classList.toggle('dark-theme', dark);
  const button = $('#theme-toggle');
  button.setAttribute('aria-pressed', String(dark));
  button.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  button.setAttribute('aria-label', button.title);
  if (persist) {
    try { localStorage.setItem('jupiter-theme', dark ? 'dark' : 'light'); } catch { /* Storage can be disabled in web previews. */ }
    app.renderInspector?.();
  }
}

function setupPanelResizers() {
  const editor = $('.editor-layout');
  const inspector = $('#inspector-panel');
  const inspectorHandle = $('#inspector-resize-handle');
  const timeline = $('#bottom-dock');
  const timelineHandle = $('#timeline-resize-handle');
  const shell = $('#app-shell');
  let activeDrag = null;

  const inspectorBounds = () => {
    const minimum = window.innerWidth <= 520 ? 190 : window.innerWidth <= 760 ? 220 : 260;
    const style = getComputedStyle(editor);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const gap = parseFloat(style.columnGap) || 0;
    const rail = editor.classList.contains('tools-collapsed') ? 0 : $('.tool-rail').getBoundingClientRect().width;
    const maximum = Math.max(minimum, Math.min(620, editor.clientWidth - padding - rail - 300 - gap * 2));
    return { minimum, maximum };
  };

  const setInspectorWidth = width => {
    const { minimum, maximum } = inspectorBounds();
    const value = Math.round(Math.max(minimum, Math.min(maximum, width)));
    editor.style.setProperty('--inspector-width', `${value}px`);
    inspectorHandle.setAttribute('aria-valuemin', String(minimum));
    inspectorHandle.setAttribute('aria-valuemax', String(maximum));
    inspectorHandle.setAttribute('aria-valuenow', String(value));
  };

  const timelineTrackHeight = () => {
    const marginBottom = parseFloat(getComputedStyle(timeline).marginBottom) || 0;
    return timeline.getBoundingClientRect().height + marginBottom;
  };
  const timelineBounds = () => {
    const minimum = 180;
    const maximum = Math.max(minimum, Math.min(Math.round(window.innerHeight * .68), window.innerHeight - 58 - 54 - 170 - 18));
    return { minimum, maximum };
  };
  const syncHandleRanges = () => {
    const inspectorRange = inspectorBounds();
    inspectorHandle.setAttribute('aria-valuemin', String(inspectorRange.minimum));
    inspectorHandle.setAttribute('aria-valuemax', String(inspectorRange.maximum));
    inspectorHandle.setAttribute('aria-valuenow', String(Math.round(inspector.getBoundingClientRect().width)));
    const timelineRange = timelineBounds();
    timelineHandle.setAttribute('aria-valuemin', String(timelineRange.minimum));
    timelineHandle.setAttribute('aria-valuemax', String(timelineRange.maximum));
    timelineHandle.setAttribute('aria-valuenow', String(Math.round(timelineTrackHeight())));
  };
  const setTimelineHeight = height => {
    const { minimum, maximum } = timelineBounds();
    const value = Math.round(Math.max(minimum, Math.min(maximum, height)));
    shell.style.setProperty('--timeline-height', `${value}px`);
    timelineHandle.setAttribute('aria-valuemin', String(minimum));
    timelineHandle.setAttribute('aria-valuemax', String(maximum));
    timelineHandle.setAttribute('aria-valuenow', String(value));
  };

  inspectorHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || editor.classList.contains('inspector-collapsed')) return;
    const { minimum, maximum } = inspectorBounds();
    activeDrag = { kind: 'inspector', pointerId: event.pointerId, min: minimum, max: maximum };
    document.body.classList.add('panel-resizing');
    event.preventDefault();
  });
  timelineHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || timeline.classList.contains('timeline-collapsed')) return;
    activeDrag = { kind: 'timeline', pointerId: event.pointerId, startY: event.clientY, startHeight: timelineTrackHeight() };
    document.body.classList.add('panel-resizing', 'timeline-panel-resizing');
    event.preventDefault();
  });

  window.addEventListener('pointermove', event => {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
    if (activeDrag.kind === 'inspector') {
      const editorRect = editor.getBoundingClientRect();
      const rightPadding = parseFloat(getComputedStyle(editor).paddingRight) || 0;
      setInspectorWidth(editorRect.right - rightPadding - event.clientX);
    } else {
      setTimelineHeight(activeDrag.startHeight + activeDrag.startY - event.clientY);
    }
  });
  const endDrag = event => {
    if (!activeDrag || (event?.pointerId != null && event.pointerId !== activeDrag.pointerId)) return;
    activeDrag = null;
    document.body.classList.remove('panel-resizing', 'timeline-panel-resizing');
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  inspectorHandle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setInspectorWidth(inspector.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -20 : 20));
  });
  timelineHandle.addEventListener('keydown', event => {
    if (event.key === 'Home') { event.preventDefault(); setTimelineHeight(timelineBounds().minimum); return; }
    if (event.key === 'End') { event.preventDefault(); setTimelineHeight(timelineBounds().maximum); return; }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    setTimelineHeight(timelineTrackHeight() + (event.key === 'ArrowUp' ? 20 : -20));
  });

  window.addEventListener('resize', syncHandleRanges);
  syncHandleRanges();
}

const titleLogo = $('#title-logo');
const titleLogoFallback = $('#theme-toggle .brand-fallback');
const refreshTitleLogo = () => {
  const available = titleLogo.complete && titleLogo.naturalWidth > 0;
  titleLogo.hidden = !available;
  titleLogoFallback.hidden = available;
};
titleLogo.addEventListener('load', refreshTitleLogo);
titleLogo.addEventListener('error', refreshTitleLogo);
titleLogo.src = '/logo.ico';
refreshTitleLogo();
try { applyTheme(localStorage.getItem('jupiter-theme') === 'dark'); } catch { applyTheme(false); }
setupPanelResizers();

// Tool selection.
$$('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
$('#undo-button').addEventListener('click', () => undo());
$('#redo-button').addEventListener('click', () => redo());
$('#zoom-in').addEventListener('click', () => { app.project.viewZoom = Math.min(5, app.project.viewZoom * 1.15); $('#zoom-label').textContent = `${Math.round(app.project.viewZoom * 100)}%`; refreshStage(); });
$('#zoom-out').addEventListener('click', () => { app.project.viewZoom = Math.max(.15, app.project.viewZoom / 1.15); $('#zoom-label').textContent = `${Math.round(app.project.viewZoom * 100)}%`; refreshStage(); });
$('#fit-canvas').addEventListener('click', () => { app.project.viewZoom = 1; $('#zoom-label').textContent = '100%'; refreshStage(); });
$('#export-placeholder').addEventListener('click', exportVideo);
$('#timeline-zoom-in').addEventListener('click', () => zoomTimeline(1));
$('#timeline-zoom-out').addEventListener('click', () => zoomTimeline(-1));
$('#play-button').addEventListener('click', playPlayback);
$('#stop-button').addEventListener('click', () => { pausePlayback(); seekFrame(0); });
$('#go-start').addEventListener('click', () => seekFrame(0));
$('#go-end').addEventListener('click', () => seekFrame(getSequenceDuration() - 1));
$('#step-back').addEventListener('click', () => seekFrame(app.project.currentFrame - 1));
$('#step-forward').addEventListener('click', () => seekFrame(app.project.currentFrame + 1));
$('#fps-select').addEventListener('change', event => { pushUndo('Change frame rate'); const old = app.project.fps; app.project.fps = Number(event.target.value); for (const clip of app.project.clips) clip.durationFrames = Math.max(1, Math.round(clip.durationFrames * app.project.fps / old)); app.renderAll(); });

$('#theme-toggle').addEventListener('click', () => applyTheme(!document.body.classList.contains('dark-theme'), true));
$('#project-menu-button').addEventListener('click', event => { event.stopPropagation(); $('#project-menu').classList.toggle('hidden'); });
$('#project-menu').addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button) runMenuAction(button.dataset.action); });
document.addEventListener('pointerdown', event => { if (!event.target.closest('#project-menu') && !event.target.closest('#project-menu-button')) closeMenu(); });
$$('[data-inspector-tab]').forEach(button => button.addEventListener('click', () => {
  activateInspectorTab(button.dataset.inspectorTab);
  app.renderInspector();
}));

$('#inspector-collapse').addEventListener('click', () => toggleInspector());
$('#toggle-inspector').addEventListener('click', () => toggleInspector());
$('#toggle-tools').addEventListener('click', () => toggleTools());
$('#toggle-timeline').addEventListener('click', () => {
  const collapsed = $('#bottom-dock').classList.toggle('timeline-collapsed');
  $('#app-shell').classList.toggle('timeline-collapsed', collapsed);
  $('#toggle-timeline').textContent = collapsed ? '⌃' : '⌄';
  $('#toggle-timeline').title = collapsed ? 'Expand timeline' : 'Collapse timeline';
  $('#toggle-timeline').setAttribute('aria-label', collapsed ? 'Expand timeline' : 'Collapse timeline');
  $('#toggle-timeline').setAttribute('aria-expanded', String(!collapsed));
});
$('#window-minimize').addEventListener('click', () => { if (tauriMode) getCurrentWindow().minimize().catch(error => window.jupiterToast(`Minimize failed: ${error}`)); });
$('#window-maximize').addEventListener('click', () => { if (tauriMode) getCurrentWindow().toggleMaximize().catch(error => window.jupiterToast(`Maximize failed: ${error}`)); else window.jupiterToast('Window controls are available in the desktop app.'); });
$('#window-close').addEventListener('click', () => { if (tauriMode) getCurrentWindow().close().catch(error => window.jupiterToast(`Close failed: ${error}`)); else window.jupiterToast('Close this browser tab to exit.'); });
$('.titlebar').addEventListener('pointerdown', event => {
  if (!tauriMode || event.button !== 0 || event.target.closest('button, input, select, a')) return;
  getCurrentWindow().startDragging().catch(() => {});
});
$('.titlebar').addEventListener('dblclick', event => {
  if (!tauriMode || event.target.closest('button, input, select, a')) return;
  getCurrentWindow().toggleMaximize().catch(() => {});
});
$('#project-name').addEventListener('dblclick', () => { const name = prompt('Project name', app.project.name); if (name?.trim()) { pushUndo('Rename project'); setProjectName(name.trim()); } });

$('#png-input').addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
$('#media-input').addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
$('#audio-input').addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
$('#project-input').addEventListener('change', event => { if (event.target.files?.[0]) openProjectFromFile(event.target.files[0]); event.target.value = ''; });
$('#media-import-button').addEventListener('click', event => { event.stopPropagation(); openMediaPicker(); });

// Use a pointer-driven internal drag instead of the WebView's custom DataTransfer
// MIME path. WebView2 can strip custom drag types; pointer dragging is deterministic.
const mediaList = $('#media-list');
function clearMediaDrag() {
  mediaDragGhost?.remove(); mediaDragGhost = null;
  document.querySelectorAll('.drop-target').forEach(element => element.classList.remove('drop-target'));
  mediaPointerDrag = null; activeDraggedAssetId = null;
  setAssetDragState(null, false);
}
mediaList.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const card = event.target.closest('.media-card');
  if (!card) return;
  const asset = findAsset(card.dataset.assetId);
  if (!asset) return;
  mediaPointerDrag = { assetId: asset.id, asset, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, started: false };
});
window.addEventListener('pointermove', event => {
  const drag = mediaPointerDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (!drag.started && distance < 7) return;
  if (!drag.started) {
    drag.started = true;
    activeDraggedAssetId = drag.assetId;
    suppressMediaClick = true;
    setAssetDragState(drag.asset.type === 'audio' ? 'audio' : 'video', true);
    mediaDragGhost = document.createElement('div');
    mediaDragGhost.className = 'media-drag-ghost';
    const thumb = document.createElement('span'); thumb.className = 'ghost-thumb';
    if (drag.asset.type === 'image') { const image = document.createElement('img'); image.src = drag.asset.dataUrl; image.alt = ''; thumb.appendChild(image); }
    else thumb.textContent = '♫';
    const label = document.createElement('strong'); label.textContent = drag.asset.name;
    mediaDragGhost.append(thumb, label); document.body.appendChild(mediaDragGhost);
  }
  event.preventDefault();
  mediaDragGhost.style.left = `${event.clientX}px`;
  mediaDragGhost.style.top = `${event.clientY}px`;
  document.querySelectorAll('.drop-target').forEach(element => element.classList.remove('drop-target'));
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.track-lane, .new-layer-drop');
  if (target) target.classList.add('drop-target');
}, { passive: false });
window.addEventListener('pointerup', event => {
  const drag = mediaPointerDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (drag.started) {
    const rect = timelineBody.getBoundingClientRect();
    const insideTimeline = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (insideTimeline) handleTimelineDrop(drag.assetId, event.clientX, event.clientY);
    else suppressMediaClick = false;
    event.preventDefault();
    setTimeout(() => { suppressMediaClick = false; }, 0);
  }
  clearMediaDrag();
}, true);
window.addEventListener('pointercancel', clearMediaDrag, true);

// Media is imported from the Inspector's Media tab. It supports an explicit
// button, clicking the empty state, double-click/right-click, and OS file drop.
const mediaPanel = $('#inspector-media');
mediaPanel.addEventListener('click', event => {
  if (event.target.closest('#media-import-prompt')) openMediaPicker();
});
mediaPanel.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('#media-import-prompt')) {
    event.preventDefault(); openMediaPicker();
  }
});
mediaPanel.addEventListener('dblclick', event => {
  if (!event.target.closest('.media-card, #media-import-prompt')) openMediaPicker();
});
mediaPanel.addEventListener('contextmenu', event => {
  if (!event.target.closest('.media-card')) { event.preventDefault(); openMediaPicker(); }
});
mediaPanel.addEventListener('dragover', event => {
  if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); mediaPanel.classList.add('media-drop-active'); }
});
mediaPanel.addEventListener('dragleave', event => {
  if (!mediaPanel.contains(event.relatedTarget)) mediaPanel.classList.remove('media-drop-active');
});
mediaPanel.addEventListener('drop', event => {
  if (event.dataTransfer?.files?.length) {
    event.preventDefault(); event.stopPropagation(); mediaPanel.classList.remove('media-drop-active');
    importFiles(event.dataTransfer.files, false);
  }
});

const timelineBody = $('#timeline-body');
timelineBody.addEventListener('dragover', event => {
  if (!hasAssetTransferType(event.dataTransfer?.types)) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  const types = Array.from(event.dataTransfer.types || []);
  const kind = types.includes('application/x-jupiter-audio') || app.project.assets.find(item => item.id === activeDraggedAssetId)?.type === 'audio' ? 'audio' : 'video';
  setAssetDragState(kind, true);
});
timelineBody.addEventListener('dragleave', event => {
  if (!timelineBody.contains(event.relatedTarget)) setAssetDragState(null, false);
});
timelineBody.addEventListener('drop', event => {
  event.preventDefault(); event.stopPropagation();
  const assetId = readAssetTransfer(event.dataTransfer, activeDraggedAssetId);
  if (assetId) handleTimelineDrop(assetId, event.clientX, event.clientY);
  else window.jupiterToast('Could not identify the dragged media. Try dragging the asset card itself.');
  setAssetDragState(null, false);
  activeDraggedAssetId = null;
});

const canvasWrap = $('#canvas-wrap');
canvasWrap.addEventListener('dragover', event => { if (event.dataTransfer.files?.length) { event.preventDefault(); canvasWrap.classList.add('drag-over'); } });
canvasWrap.addEventListener('dragleave', () => canvasWrap.classList.remove('drag-over'));
canvasWrap.addEventListener('drop', event => {
  event.preventDefault(); canvasWrap.classList.remove('drag-over');
  if (event.dataTransfer.files?.length) importFiles(event.dataTransfer.files, true);
});
window.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', event => { if (event.dataTransfer?.files?.length && !event.target?.closest?.('#timeline-body, #canvas-wrap')) event.preventDefault(); });

window.addEventListener('keydown', event => {
  if (event.target.matches('input, textarea, select') || event.target.isContentEditable) return;
  const key = event.key.toLowerCase();
  if (event.code === 'Space') { event.preventDefault(); if (!spaceHeld) playPlayback(); spaceHeld = true; }
  else if ((event.ctrlKey || event.metaKey) && key === 's') { event.preventDefault(); saveProject(false); }
  else if ((event.ctrlKey || event.metaKey) && key === 'o') { event.preventDefault(); openProject(); }
  else if ((event.ctrlKey || event.metaKey) && key === 'n') { event.preventDefault(); newProject(); }
  else if ((event.ctrlKey || event.metaKey) && key === 'z' && event.shiftKey) { event.preventDefault(); redo(); }
  else if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); undo(); }
  else if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redo(); }
  else if (key === 'v') setTool('select');
  else if (key === 'm') setTool('move');
  else if (key === 'r') setTool('rig');
  else if (key === 'n') setTool('node');
  else if (key === 'delete' || key === 'backspace') {
    const clip = findClip(app.project.selectedClipId);
    if (clip && app.project.selectedNodeId) { pushUndo('Delete joint'); deleteNode(clip, app.project.selectedNodeId); app.renderAll(); }
    else if (clip) removeClip(clip.id);
  }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); pausePlayback(); seekFrame(app.project.currentFrame - 1); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); pausePlayback(); seekFrame(app.project.currentFrame + 1); }
  else if (event.key === 'Home') { event.preventDefault(); seekFrame(0); }
});
window.addEventListener('keyup', event => { if (event.code === 'Space') spaceHeld = false; });

if (tauriMode) {
  try {
    getCurrentWindow().onDragDropEvent(async event => {
      if (event.payload.type === 'drop') await importNativePaths(event.payload.paths, false);
    });
  } catch (error) { console.warn('Native drop integration unavailable', error); }
}

renderAll();
refreshFfmpegStatus();

