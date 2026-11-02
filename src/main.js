import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { app, createProject, makeId, pushUndo, undo, redo, addClip, removeClip, addTrack, findAsset, findClip, findTrack, getActiveClip, clipStartFrame, getSequenceDuration } from './modules/state.js';
import { loadImageAsset, refreshStage, setTool, renderStageNow } from './modules/stage.js';
import { evaluateNode, setNodePose, evaluateClipTransform, setClipTransformValue, TRANSFORM_PROPERTIES, deleteNode } from './modules/rig.js';
import { zoomTimeline, seekFrame, refreshTimeline, updateTimelinePlayhead, handleTimelineDrop, setAssetDragState } from './modules/timeline.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const tauriMode = !!window.__TAURI_INTERNALS__;
let playbackRequest = 0;
let playbackAnchor = 0;
let playbackStartFrame = 0;
let projectPath = null;
let spaceHeld = false;
let currentAudio = new Map();

window.jupiterToast = message => {
  const region = $('#toast-region');
  const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = message;
  region.appendChild(toast); setTimeout(() => toast.remove(), 2900);
};

function setProjectName(name) {
  app.project.name = name || 'Untitled';
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
function imageDimensions(dataUrl) {
  return new Promise(resolve => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => resolve({ width: 0, height: 0 }); image.src = dataUrl; });
}
function audioDuration(dataUrl) {
  return new Promise(resolve => {
    const audio = new Audio(); audio.preload = 'metadata'; audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : 5); audio.onerror = () => resolve(5); audio.src = dataUrl;
  });
}

async function importFiles(fileList, autoInsert = false) {
  const files = [...fileList];
  for (const file of files) {
    if (!file.type.startsWith('image/') && !file.type.startsWith('audio/')) continue;
    try {
      const dataUrl = await fileToDataUrl(file);
      const image = file.type.startsWith('image/');
      const metadata = image ? await imageDimensions(dataUrl) : { width: 0, height: 0 };
      const duration = image ? null : await audioDuration(dataUrl);
      const asset = {
        id: makeId('asset'), name: file.name, type: image ? 'image' : 'audio', mime: file.type || (image ? 'image/png' : 'audio/mpeg'),
        dataUrl, width: metadata.width, height: metadata.height, duration,
      };
      pushUndo('Import media');
      app.project.assets.push(asset);
      app.project.selectedAssetId = asset.id;
      if (image) await loadImageAsset(asset);
      if (autoInsert) addClip(asset.id);
    } catch (error) { window.jupiterToast(`Couldn't import ${file.name}: ${error.message || error}`); }
  }
  if (files.length) app.project.inspectorTab = autoInsert ? 'values' : 'media';
  app.renderAll();
}

async function importNativePaths(paths, autoInsert = false) {
  for (const path of paths) {
    try {
      const assetData = await invoke('read_asset', { path });
      const type = assetData.mime.startsWith('image/') ? 'image' : assetData.mime.startsWith('audio/') ? 'audio' : null;
      if (!type) { window.jupiterToast(`Unsupported media: ${assetData.name}`); continue; }
      const dataUrl = `data:${assetData.mime};base64,${assetData.data_base64}`;
      const metadata = type === 'image' ? await imageDimensions(dataUrl) : { width: 0, height: 0 };
      const duration = type === 'audio' ? await audioDuration(dataUrl) : null;
      const asset = { id: makeId('asset'), name: assetData.name, type, mime: assetData.mime, dataUrl, width: metadata.width, height: metadata.height, duration };
      pushUndo('Import media'); app.project.assets.push(asset); app.project.selectedAssetId = asset.id;
      if (type === 'image') await loadImageAsset(asset);
      if (autoInsert) addClip(asset.id);
    } catch (error) { window.jupiterToast(`Couldn't import file: ${String(error).slice(0, 120)}`); }
  }
  if (paths.length) app.project.inspectorTab = autoInsert ? 'values' : 'media';
  app.renderAll();
}

function renderMedia() {
  const container = $('#media-list');
  $('#media-count').textContent = String(app.project.assets.length);
  if (!app.project.assets.length) {
    container.innerHTML = '<div class="media-empty">No media yet.<br><br>Import an image or audio file, then drag it onto V1 or A1.</div>';
    return;
  }
  container.innerHTML = '';
  for (const asset of app.project.assets) {
    const card = document.createElement('div');
    card.className = `media-card${asset.id === app.project.selectedAssetId ? ' selected' : ''}`;
    card.draggable = true; card.dataset.assetId = asset.id;
    const thumb = document.createElement('div'); thumb.className = 'media-thumb';
    if (asset.type === 'image') {
      const img = document.createElement('img'); img.src = asset.dataUrl; img.alt = ''; thumb.appendChild(img);
    } else {
      thumb.textContent = '♫';
    }
    const name = document.createElement('strong'); name.textContent = asset.name;
    const meta = document.createElement('small');
    meta.textContent = asset.type === 'image' ? `${asset.width} × ${asset.height}` : `${asset.duration?.toFixed(1) ?? '—'} sec`;
    card.append(thumb, name, meta);
    card.addEventListener('click', () => {
      app.project.selectedAssetId = asset.id;
      app.project.selectedClipId = null;
      app.project.selectedNodeId = null;
      app.project.inspectorTab = 'media';
      $$('[data-inspector-tab]').forEach(button => button.classList.toggle('active', button.dataset.inspectorTab === 'media'));
      $('#inspector-values').classList.add('hidden'); $('#inspector-media').classList.remove('hidden');
      app.renderInspector(); renderMedia();
    });
    card.addEventListener('dblclick', () => addClip(asset.id));
    card.addEventListener('dragstart', event => {
      event.dataTransfer.setData('application/x-jupiter-asset', asset.id);
      event.dataTransfer.setData('application/x-jupiter-kind', asset.type === 'audio' ? 'audio' : 'video');
      event.dataTransfer.setData(asset.type === 'audio' ? 'application/x-jupiter-audio' : 'application/x-jupiter-video', asset.id);
      event.dataTransfer.effectAllowed = 'copy';
    });
    card.addEventListener('dragend', () => setAssetDragState(null, false));
    container.appendChild(card);
  }
}

function localFrameFor(clip) {
  return Math.max(0, Math.min(clip.durationFrames - 1, app.project.currentFrame - clipStartFrame(clip.id)));
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
  input.addEventListener('change', () => options.onChange(Number(input.value), key));
  row.append(caption, input);
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
  const title = document.createElement('strong'); title.textContent = 'GRAPH';
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
  const canvas = document.createElement('canvas'); canvas.className = 'curve-canvas'; canvas.height = 140;
  const footer = document.createElement('div'); footer.className = 'graph-footer'; footer.textContent = 'DRAG KEY POINTS TO ADJUST TIME AND VALUE · DIAMONDS ARE KEYFRAMES';
  section.append(heading, canvas, footer); parent.appendChild(section);

  const drawGraph = () => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(180, Math.floor(rect.width));
    const height = 140; const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr; canvas.height = height * dpr;
    const c = canvas.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, width, height);
    const current = graphValues(clip, node, property.value);
    const values = current.points.map(point => Number(current.isNode ? point[current.axis] : point.value) || 0);
    let min = Math.min(...values), max = Math.max(...values);
    if (current.axis === 'opacity') { min = 0; max = 1; }
    if (Math.abs(max - min) < 1e-5) { min -= .5; max += .5; }
    const pad = Math.max((max - min) * .16, .08); min -= pad; max += pad;
    const left = 26, right = width - 10, top = 10, bottom = height - 18;
    const maxFrame = Math.max(1, clip.durationFrames - 1);
    const px = frame => left + (Math.max(0, Math.min(maxFrame, frame)) / maxFrame) * (right - left);
    const py = value => bottom - ((value - min) / (max - min)) * (bottom - top);
    c.strokeStyle = '#e4e9ee'; c.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const y = top + (bottom - top) * i / 4; c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke(); }
    for (let i = 0; i <= 5; i++) { const x = left + (right - left) * i / 5; c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke(); }
    c.fillStyle = '#9ba6b0'; c.font = '7px Inter'; c.fillText('0', 5, bottom + 3); c.fillText(String(maxFrame), right - 16, height - 4);
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
      c.strokeStyle = '#6487a5'; c.lineWidth = 1.5; c.stroke();
      for (const point of points) {
        c.beginPath(); c.arc(px(point.frame), py(point.value), point.source.__base ? 2.3 : 3.5, 0, Math.PI * 2);
        c.fillStyle = point.source.__base ? '#fff' : '#6487a5'; c.fill(); c.strokeStyle = '#4f7697'; c.lineWidth = 1; c.stroke();
      }
    }
    return { current, px, py, min, max, left, right, top, bottom, maxFrame };
  };
  drawGraph();
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
  const media = $('#inspector-media');
  const clip = findClip(app.project.selectedClipId);
  const asset = findAsset(app.project.selectedAssetId) || (clip ? findAsset(clip.assetId) : null);
  const node = clip?.rig?.nodes.find(item => item.id === app.project.selectedNodeId);
  values.innerHTML = '';

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
      onChange: value => { if (!Number.isFinite(value)) return; pushUndo('Set joint X'); const next = { ...pos, x: value / 100 }; if (app.project.autoKey !== false) setNodePose(clip, node.id, next, app.project.currentFrame, start); else node.x = next.x; app.renderAll(); },
    }));
    rigSection.append(propertyField('Y position · %', (pos.y * 100).toFixed(1), 'y', {
      keyActive: nodeKey, keyAction: () => togglePropertyKey(clip, { node }),
      onChange: value => { if (!Number.isFinite(value)) return; pushUndo('Set joint Y'); const next = { ...pos, y: value / 100 }; if (app.project.autoKey !== false) setNodePose(clip, node.id, next, app.project.currentFrame, start); else node.y = next.y; app.renderAll(); },
    }));
    const actionRow = document.createElement('div'); actionRow.className = 'property-actions';
    const deleteButton = document.createElement('button'); deleteButton.className = 'small-action'; deleteButton.textContent = 'Delete joint';
    deleteButton.addEventListener('click', () => { pushUndo('Delete joint'); deleteNode(clip, node.id); app.renderAll(); });
    const selectTool = document.createElement('button'); selectTool.className = 'small-action'; selectTool.textContent = 'Node tool (N)'; selectTool.addEventListener('click', () => { app.project.activeTool = 'node'; app.renderAll(); });
    actionRow.append(deleteButton, selectTool); rigSection.appendChild(actionRow);
    values.appendChild(rigSection);
  }

  if (clip && asset?.type === 'image') {
    const start = clipStartFrame(clip.id), localFrame = localFrameFor(clip);
    const transform = evaluateClipTransform(clip, localFrame);
    const section = document.createElement('section'); section.className = 'property-section';
    section.innerHTML = '<h3>ARTWORK TRANSFORM</h3><p class="property-note">Move tool (M) moves this layer. Auto Key records edits at the playhead.</p>';
    const transformFields = [
      ['Position X', 'x', transform.x, '0.1'], ['Position Y', 'y', transform.y, '0.1'],
      ['Rotation', 'rotation', transform.rotation, '1'], ['Scale', 'scale', transform.scale, '0.01'], ['Opacity', 'opacity', transform.opacity, '0.01'],
    ];
    for (const [label, key, value, step] of transformFields) {
      section.append(propertyField(label, Number(value).toFixed(key === 'x' || key === 'y' ? 1 : 2), key, {
        step,
        keyActive: hasTransformKey(clip, key, localFrame),
        keyAction: () => togglePropertyKey(clip, { property: key }),
        onChange: next => {
          if (!Number.isFinite(next)) return;
          const clamped = key === 'scale' ? Math.max(.01, next) : key === 'opacity' ? Math.max(0, Math.min(1, next)) : next;
          pushUndo('Edit artwork transform');
          if (app.project.autoKey !== false) setClipTransformValue(clip, key, clamped, app.project.currentFrame, start);
          else clip.transform[key] = clamped;
          app.renderAll();
        },
      }));
    }
    const rig = clip.rig;
    const rigInfo = document.createElement('section'); rigInfo.className = 'property-section';
    rigInfo.innerHTML = `<h3>RIG</h3><div class="property-row"><label>Joints</label><span>${rig?.nodes?.length ?? 0}</span><span></span></div><div class="property-row"><label>Limbs</label><span>${rig?.bones?.length ?? 0}</span><span></span></div><p class="property-note">Rig (R): drag from a point to create a limb; Shift-drag to connect to another point. Node (N): edit joints only. Move (M): move the artwork only.</p>`;
    values.appendChild(section);
    // Keep the animation graph directly beneath Transform in the same Values view.
    // Media remains a single top-level Inspector tab; the graph has no Media sub-tab.
    renderGraphEditor(values, clip, node || null);
    values.appendChild(rigInfo);
    const hierarchy = rigHierarchySection(clip); if (hierarchy) values.appendChild(hierarchy);
  } else if (!node && asset) {
    const section = document.createElement('section'); section.className = 'property-section';
    section.innerHTML = `<h3>MEDIA DETAILS</h3><div class="media-detail">${asset.type === 'image' ? `<img src="${asset.dataUrl}" alt="">` : '<div class="media-thumb">♫</div>'}<div><strong></strong><span></span></div></div>`;
    section.querySelector('strong').textContent = asset.name;
    section.querySelector('span').textContent = asset.type === 'image' ? `${asset.width} × ${asset.height} px` : `${asset.duration?.toFixed(1) ?? '—'} seconds`;
    values.appendChild(section);
    if (asset.type === 'image') {
      const hint = document.createElement('p'); hint.className = 'property-note'; hint.textContent = 'Drag this image from Media onto V1 to add it to the sequence.'; values.appendChild(hint);
    }
  } else if (!node && !asset) {
    values.innerHTML = '<div class="inspector-empty">Select a clip or joint to edit its values. Switch to Media to import and organize files.</div>';
  }

  media.innerHTML = '';
  if (!asset) { media.innerHTML = '<div class="inspector-empty">Select a media item to see its source details.</div>'; }
  else {
    const section = document.createElement('section'); section.className = 'property-section';
    section.innerHTML = `<h3>MEDIA SOURCE</h3><div class="media-detail">${asset.type === 'image' ? `<img src="${asset.dataUrl}" alt="">` : '<div class="media-thumb">♫</div>'}<div><strong></strong><span></span></div></div>`;
    section.querySelector('strong').textContent = asset.name;
    section.querySelector('span').textContent = `${asset.mime} · ${asset.type === 'image' ? `${asset.width} × ${asset.height}` : `${asset.duration?.toFixed(1) ?? '—'} sec`}`;
    media.appendChild(section);
    const hint = document.createElement('p'); hint.className = 'property-note'; hint.textContent = asset.type === 'image' ? 'Drag to V1, or to the temporary +V2 / +V3 layer target while dragging.' : 'Drag to A1, or to the temporary +A2 / +A3 layer target while dragging.';
    media.appendChild(hint);
  }
}

function renderToolbar() {
  $$('[data-tool]').forEach(button => button.classList.toggle('active', button.dataset.tool === app.project.activeTool));
  const labels = { select: 'SELECT', move: 'MOVE ARTWORK', rig: 'RIG', node: 'NODE' };
  $('#tool-status').textContent = labels[app.project.activeTool] || 'SELECT MODE';
  $('#stage-mode-label').textContent = ({ select: 'SELECT · ARTWORK OR JOINT', move: 'MOVE · ARTWORK ONLY', rig: 'RIG · DRAW BONES', node: 'NODE · JOINTS ONLY' })[app.project.activeTool] || 'SELECT';
  $('#undo-button').disabled = !app.history.length;
  $('#redo-button').disabled = !app.future.length;
  $('#auto-key-toggle').classList.toggle('active', app.project.autoKey !== false);
  $('#auto-key-toggle').setAttribute('aria-pressed', String(app.project.autoKey !== false));
}

function renderAll() {
  setProjectName(app.project.name);
  renderMedia(); renderInspector(); renderToolbar(); refreshTimeline(); refreshStage();
  const tab = app.project.inspectorTab === 'media' ? 'media' : 'values';
  $$('[data-inspector-tab]').forEach(button => button.classList.toggle('active', button.dataset.inspectorTab === tab));
  $('#inspector-values').classList.toggle('hidden', tab !== 'values');
  $('#inspector-media').classList.toggle('hidden', tab !== 'media');
  $('#auto-key-toggle').classList.toggle('active', app.project.autoKey !== false);
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
    let cursor = 0;
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
    audio.currentTime = Math.max(0, item.local / app.project.fps);
    audio.volume = 1; audio.play().catch(() => {}); currentAudio.set(id, audio);
  }
}

function pausePlayback() {
  app.project.playing = false;
  cancelAnimationFrame(playbackRequest); playbackRequest = 0;
  stopAudio();
  $('#play-button').classList.remove('playing'); $('#play-button').textContent = '▶';
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
  data.autoKey = data.autoKey !== false;
  data.tracks.forEach(track => { track.clipIds ??= []; });
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
app.renderAll = renderAll;

function toggleInspector() {
  const collapsed = $('#inspector-panel').classList.toggle('collapsed');
  $('.editor-layout').classList.toggle('inspector-collapsed', collapsed);
  $('#toggle-inspector').textContent = collapsed ? '‹' : '›';
}
function toggleTools() {
  const collapsed = $('.editor-layout').classList.toggle('tools-collapsed');
  $('#toggle-tools').textContent = collapsed ? '›' : '‹';
  $('#toggle-tools').title = collapsed ? 'Show tools' : 'Collapse tools';
}

// Tool selection.
$$('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
$('#import-png-button').addEventListener('click', () => $('#png-input').click());
$('#empty-import').addEventListener('click', () => $('#png-input').click());
$('#media-import-button').addEventListener('click', () => { $('#media-input').click(); });
$('#undo-button').addEventListener('click', () => undo());
$('#redo-button').addEventListener('click', () => redo());
$('#fit-stage').addEventListener('click', () => { app.project.viewZoom = 1; app.project.viewPan = { x: 0, y: 0 }; $('#zoom-label').textContent = '100%'; refreshStage(); });
$('#zoom-in').addEventListener('click', () => { app.project.viewZoom = Math.min(5, app.project.viewZoom * 1.15); $('#zoom-label').textContent = `${Math.round(app.project.viewZoom * 100)}%`; refreshStage(); });
$('#zoom-out').addEventListener('click', () => { app.project.viewZoom = Math.max(.15, app.project.viewZoom / 1.15); $('#zoom-label').textContent = `${Math.round(app.project.viewZoom * 100)}%`; refreshStage(); });
$('#timeline-zoom-in').addEventListener('click', () => zoomTimeline(1));
$('#timeline-zoom-out').addEventListener('click', () => zoomTimeline(-1));
$('#auto-key-toggle').addEventListener('click', () => { app.project.autoKey = app.project.autoKey === false; renderToolbar(); window.jupiterToast(`Auto Key ${app.project.autoKey ? 'on' : 'off'}.`); });
$('#play-button').addEventListener('click', playPlayback);
$('#stop-button').addEventListener('click', () => { pausePlayback(); seekFrame(0); });
$('#go-start').addEventListener('click', () => seekFrame(0));
$('#go-end').addEventListener('click', () => seekFrame(getSequenceDuration() - 1));
$('#keyframe-button').addEventListener('click', addKeyframeAtPlayhead);
$('#step-back').addEventListener('click', () => seekFrame(app.project.currentFrame - 1));
$('#step-forward').addEventListener('click', () => seekFrame(app.project.currentFrame + 1));
$('#fps-select').addEventListener('change', event => { pushUndo('Change frame rate'); const old = app.project.fps; app.project.fps = Number(event.target.value); for (const clip of app.project.clips) clip.durationFrames = Math.max(1, Math.round(clip.durationFrames * app.project.fps / old)); app.renderAll(); });

$('#project-menu-button').addEventListener('click', event => { event.stopPropagation(); $('#project-menu').classList.toggle('hidden'); });
$('#project-menu').addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button) runMenuAction(button.dataset.action); });
document.addEventListener('pointerdown', event => { if (!event.target.closest('#project-menu') && !event.target.closest('#project-menu-button')) closeMenu(); });
$$('[data-inspector-tab]').forEach(button => button.addEventListener('click', () => {
  app.project.inspectorTab = button.dataset.inspectorTab;
  $$('[data-inspector-tab]').forEach(item => item.classList.toggle('active', item === button));
  $('#inspector-values').classList.toggle('hidden', app.project.inspectorTab !== 'values');
  $('#inspector-media').classList.toggle('hidden', app.project.inspectorTab !== 'media');
}));

$('#inspector-collapse').addEventListener('click', () => toggleInspector());
$('#toggle-inspector').addEventListener('click', () => toggleInspector());
$('#toggle-tools').addEventListener('click', () => toggleTools());
$('#toggle-timeline').addEventListener('click', () => { const collapsed = $('#bottom-dock').classList.toggle('timeline-collapsed'); $('#app-shell').classList.toggle('timeline-collapsed', collapsed); $('#toggle-timeline').textContent = collapsed ? '⌃' : '⌄'; });
async function runWindowAction(action, label) {
  if (!tauriMode) {
    window.jupiterToast(`${label} is available in the desktop build.`);
    return;
  }
  try {
    await action();
  } catch (error) {
    window.jupiterToast(`Couldn't ${label.toLowerCase()}: ${String(error).slice(0, 120)}`);
  }
}

$('#window-minimize').addEventListener('click', () => runWindowAction(() => getCurrentWindow().minimize(), 'Minimize'));
$('#window-maximize').addEventListener('click', () => runWindowAction(() => getCurrentWindow().toggleMaximize(), 'Maximize / restore'));
$('#window-close').addEventListener('click', () => runWindowAction(() => getCurrentWindow().close(), 'Close'));
$('.titlebar').addEventListener('pointerdown', event => {
  if (!tauriMode || event.button !== 0 || event.target.closest('button, input, select, a')) return;
  runWindowAction(() => getCurrentWindow().startDragging(), 'Drag window');
});
$('.titlebar').addEventListener('dblclick', event => {
  if (!tauriMode || event.target.closest('button, input, select, a')) return;
  runWindowAction(() => getCurrentWindow().toggleMaximize(), 'Maximize / restore');
});
$('#project-name').addEventListener('dblclick', () => { const name = prompt('Project name', app.project.name); if (name?.trim()) { pushUndo('Rename project'); setProjectName(name.trim()); } });

$('#png-input').addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
$('#media-input').addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
$('#audio-input').addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
$('#project-input').addEventListener('change', event => { if (event.target.files?.[0]) openProjectFromFile(event.target.files[0]); event.target.value = ''; });

const timelineBody = $('#timeline-body');
timelineBody.addEventListener('dragover', event => {
  if (!event.dataTransfer.types.includes('application/x-jupiter-asset')) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  const kind = event.dataTransfer.types.includes('application/x-jupiter-audio') ? 'audio' : 'video';
  setAssetDragState(kind, true);
});
timelineBody.addEventListener('dragleave', event => {
  if (!timelineBody.contains(event.relatedTarget)) setAssetDragState(null, false);
});
timelineBody.addEventListener('drop', event => {
  event.preventDefault();
  const assetId = event.dataTransfer.getData('application/x-jupiter-asset');
  if (assetId) handleTimelineDrop(assetId, event.clientX, event.clientY);
  else setAssetDragState(null, false);
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

async function initializeLiquidGlass() {
  // Keep the upstream library's WebGL blur/refraction as a restrained white
  // frosting pass only. The CSS surface is the offline/WebGL fallback.
  try {
    if (typeof Container === 'undefined' || typeof html2canvas === 'undefined') return;
    window.glassControls = {
      edgeIntensity: .001, rimIntensity: .001, baseIntensity: .001,
      edgeDistance: .18, rimDistance: .8, baseDistance: .12,
      cornerBoost: .001, rippleEffect: .0001, blurRadius: 7,
    };
    const panels = ['.inspector', '.bottom-dock', '.commandbar', '.tool-rail'];
    for (const selector of panels) {
      const panel = $(selector); if (!panel || panel.dataset.liquidEnhanced) continue;
      const overlay = new Container({ borderRadius: 9, tintOpacity: .22 });
      overlay.element.style.position = 'absolute'; overlay.element.style.inset = '0';
      overlay.element.style.width = '100%'; overlay.element.style.height = '100%';
      overlay.element.style.padding = '0'; overlay.element.style.gap = '0';
      overlay.element.style.pointerEvents = 'none'; overlay.element.style.zIndex = '0';
      overlay.canvas.style.zIndex = '0'; overlay.canvas.style.boxShadow = 'none';
      panel.prepend(overlay.element);
      for (const child of [...panel.children]) if (child !== overlay.element) {
        child.style.position ||= 'relative'; child.style.zIndex = '1';
      }
      panel.dataset.liquidEnhanced = 'true';
      const observer = new ResizeObserver(() => overlay.updateSizeFromDOM()); observer.observe(panel);
    }
  } catch (error) { console.info('White frost CSS fallback remains active.', error); }
}

renderAll();
setTimeout(initializeLiquidGlass, 450);
