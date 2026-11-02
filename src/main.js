import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { app, createProject, makeId, pushUndo, undo, redo, addClip, removeClip, addTrack, findAsset, findClip, findTrack, getActiveClip, clipStartFrame, getSequenceDuration } from './modules/state.js';
import { loadImageAsset, refreshStage, setTool, renderStageNow } from './modules/stage.js';
import { evaluateNode, setNodePose, evaluateClipTransform, setClipTransformValue, TRANSFORM_PROPERTIES, deleteNode } from './modules/rig.js';
import { zoomTimeline, seekFrame, refreshTimeline, updateTimelinePlayhead, handleTimelineDrop } from './modules/timeline.js';

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
  app.renderAll();
}

function renderMedia() {
  const container = $('#media-list');
  $('#media-count').textContent = String(app.project.assets.length);
  if (!app.project.assets.length) {
    container.innerHTML = '<div class="media-empty">Your imported PNGs and audio will appear here.<br><br>Import a file, then drag it onto a track.</div>';
    return;
  }
  container.innerHTML = '';
  for (const asset of app.project.assets) {
    const card = document.createElement('div');
    card.className = `media-card${asset.id === app.project.selectedAssetId ? ' selected' : ''}`;
    card.draggable = true; card.dataset.assetId = asset.id;
    const thumb = document.createElement('div'); thumb.className = `media-thumb${asset.type === 'audio' ? ' audio' : ''}`;
    if (asset.type === 'image') { const img = document.createElement('img'); img.src = asset.dataUrl; img.alt = ''; thumb.appendChild(img); }
    else thumb.textContent = '♫';
    const name = document.createElement('strong'); name.textContent = asset.name;
    const meta = document.createElement('small'); meta.textContent = asset.type === 'image' ? `${asset.width} × ${asset.height}` : `${asset.duration?.toFixed(1) ?? '—'} sec`;
    card.append(thumb, name, meta);
    card.addEventListener('click', () => { app.project.selectedAssetId = asset.id; app.project.selectedClipId = null; app.project.selectedNodeId = null; app.renderAll(); });
    card.addEventListener('dblclick', () => addClip(asset.id));
    card.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-jupiter-asset', asset.id); event.dataTransfer.effectAllowed = 'copy'; });
    container.appendChild(card);
  }
}

function propertyField(label, value, key, options = {}) {
  const row = document.createElement('div'); row.className = 'property-row';
  const caption = document.createElement('label'); caption.textContent = label;
  const input = document.createElement('input'); input.type = options.type || 'number'; input.value = value ?? ''; input.step = options.step || '0.01';
  input.addEventListener('change', () => options.onChange(Number(input.value), key));
  row.append(caption, input); return row;
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
    button.addEventListener('click', () => { app.project.selectedClipId = clip.id; app.project.selectedNodeId = node.id; app.renderAll(); });
    tree.appendChild(button);
  }
  section.appendChild(tree);
  return section;
}

function renderInspector() {
  const values = $('#inspector-values');
  const media = $('#inspector-media');
  const clip = findClip(app.project.selectedClipId);
  const asset = findAsset(app.project.selectedAssetId) || (clip ? findAsset(clip.assetId) : null);
  const node = clip?.rig?.nodes.find(item => item.id === app.project.selectedNodeId);
  values.innerHTML = '';
  if (node && clip) {
    const start = clipStartFrame(clip.id); const local = app.project.currentFrame - start;
    const pos = evaluateNode(node, Math.max(0, local));
    const rigSection = document.createElement('section'); rigSection.className = 'property-section';
    rigSection.innerHTML = `<h3>SELECTED JOINT</h3>`;
    const nameRow = document.createElement('div'); nameRow.className = 'property-row';
    const nameLabel = document.createElement('label'); nameLabel.textContent = 'Name';
    const nameInput = document.createElement('input'); nameInput.type = 'text'; nameInput.value = node.name;
    nameInput.addEventListener('change', () => { pushUndo('Rename joint'); node.name = nameInput.value.trim() || 'Joint'; app.renderAll(); });
    nameRow.append(nameLabel, nameInput); rigSection.appendChild(nameRow);
    rigSection.append(propertyField('X · %', (pos.x * 100).toFixed(1), 'x', { onChange: value => { pushUndo('Set joint position'); setNodePose(clip, node.id, { ...pos, x: value / 100 }, app.project.currentFrame, start); app.renderAll(); } }));
    rigSection.append(propertyField('Y · %', (pos.y * 100).toFixed(1), 'y', { onChange: value => { pushUndo('Set joint position'); setNodePose(clip, node.id, { ...pos, y: value / 100 }, app.project.currentFrame, start); app.renderAll(); } }));
    rigSection.innerHTML += `<p class="property-note">Node Tool (N) moves joints only. Rig Tool (R) draws new limbs from a joint; hold Shift to connect to an existing joint.</p>`;
    const actionRow = document.createElement('div'); actionRow.className = 'property-row';
    const deleteButton = document.createElement('button'); deleteButton.className = 'command-button'; deleteButton.textContent = 'Delete joint';
    deleteButton.addEventListener('click', () => { pushUndo('Delete joint'); deleteNode(clip, node.id); app.renderAll(); });
    actionRow.append(deleteButton); rigSection.appendChild(actionRow);
    values.append(rigSection);
  }

  if (clip && asset?.type === 'image') {
    const start = clipStartFrame(clip.id);
    const localFrame = Math.max(0, app.project.currentFrame - start);
    const transform = evaluateClipTransform(clip, localFrame);
    const section = document.createElement('section'); section.className = 'property-section';
    section.innerHTML = '<h3>ARTWORK TRANSFORM</h3><p class="property-note">Auto Key records value changes at the current playhead position.</p>';
    const transformFields = [
      ['Position X', 'x', transform.x, '0.1'],
      ['Position Y', 'y', transform.y, '0.1'],
      ['Rotation', 'rotation', transform.rotation, '1'],
      ['Scale', 'scale', transform.scale, '0.01'],
      ['Opacity', 'opacity', transform.opacity, '0.01'],
    ];
    for (const [label, key, value, step] of transformFields) {
      section.append(propertyField(label, Number(value).toFixed(key === 'x' || key === 'y' ? 1 : 2), key, {
        step,
        onChange: next => {
          if (!Number.isFinite(next)) return;
          const clamped = key === 'scale' ? Math.max(.01, next) : key === 'opacity' ? Math.max(0, Math.min(1, next)) : next;
          pushUndo('Animate artwork transform');
          setClipTransformValue(clip, key, clamped, app.project.currentFrame, start);
          app.renderAll();
        },
      }));
    }
    values.appendChild(section);
    const rig = clip.rig;
    const rigInfo = document.createElement('section'); rigInfo.className = 'property-section';
    rigInfo.innerHTML = `<h3>RIG</h3><div class="property-row"><label>Joints</label><span>${rig?.nodes?.length ?? 0}</span></div><div class="property-row"><label>Limbs</label><span>${rig?.bones?.length ?? 0}</span></div><p class="property-note">Select Rig (R), drag from a joint to create a limb. Shift-drag to connect into an existing joint. Node (N) edits existing limbs without creating new ones.</p>`;
    values.appendChild(rigInfo);
    const hierarchy = rigHierarchySection(clip); if (hierarchy) values.appendChild(hierarchy);
  } else if (!node && asset) {
    const section = document.createElement('section'); section.className = 'property-section';
    section.innerHTML = `<h3>MEDIA DETAILS</h3><div class="media-detail">${asset.type === 'image' ? `<img src="${asset.dataUrl}" alt="">` : '<div class="media-thumb audio">♫</div>'}<div><strong></strong><span></span></div></div>`;
    section.querySelector('strong').textContent = asset.name;
    section.querySelector('span').textContent = asset.type === 'image' ? `${asset.width} × ${asset.height} px` : `${asset.duration?.toFixed(1) ?? '—'} seconds`;
    values.appendChild(section);
    if (asset.type === 'image') {
      const hint = document.createElement('p'); hint.className = 'property-note'; hint.textContent = 'Drag this item onto the main video track to add it to your animation.'; values.appendChild(hint);
    }
  } else if (!node && !asset) {
    values.innerHTML = '<div class="inspector-empty">Select an image, timeline clip or rig joint to edit its values.</div>';
  }

  media.innerHTML = '';
  if (!asset) { media.innerHTML = '<div class="inspector-empty">Select an item in Media to see its details.</div>'; }
  else {
    const section = document.createElement('section'); section.className = 'property-section'; section.innerHTML = `<h3>MEDIA SOURCE</h3><div class="media-detail">${asset.type === 'image' ? `<img src="${asset.dataUrl}" alt="">` : '<div class="media-thumb audio">♫</div>'}<div><strong></strong><span></span></div></div>`;
    section.querySelector('strong').textContent = asset.name;
    section.querySelector('span').textContent = asset.mime;
    media.appendChild(section);
  }
}

function renderToolbar() {
  $$('[data-tool]').forEach(button => button.classList.toggle('active', button.dataset.tool === app.project.activeTool));
  const labels = { select: 'SELECT MODE', rig: 'RIG MODE', node: 'NODE MODE' };
  $('#tool-status').textContent = labels[app.project.activeTool] || 'SELECT MODE';
  $('#stage-mode-label').textContent = app.project.activeTool === 'rig' ? 'RIG · DRAW LIMBS' : app.project.activeTool === 'node' ? 'NODE · EDIT JOINTS' : 'SELECT · IMAGE';
  $('#undo-button').disabled = !app.history.length;
  $('#redo-button').disabled = !app.future.length;
}

function renderAll() {
  setProjectName(app.project.name);
  renderMedia(); renderInspector(); renderToolbar(); refreshTimeline(); refreshStage();
  $('#stage-empty').classList.toggle('hidden', !!getActiveClip()?.asset);
}

function addKeyframeAtPlayhead() {
  const active = getActiveClip();
  const clip = findClip(app.project.selectedClipId) || active?.clip;
  const asset = clip && findAsset(clip.assetId);
  if (!clip || asset?.type !== 'image') { window.jupiterToast('Select an image clip first.'); return; }
  const start = clipStartFrame(clip.id);
  const localFrame = Math.max(0, app.project.currentFrame - start);
  pushUndo('Insert keyframe');
  for (const node of clip.rig?.nodes || []) {
    const pose = evaluateNode(node, localFrame);
    setNodePose(clip, node.id, pose, app.project.currentFrame, start);
  }
  const transform = evaluateClipTransform(clip, localFrame);
  for (const property of TRANSFORM_PROPERTIES) {
    setClipTransformValue(clip, property, transform[property], app.project.currentFrame, start);
  }
  app.renderAll();
  window.jupiterToast(`Keyframes added at frame ${localFrame}.`);
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
  data.tracks.forEach(track => { track.clipIds ??= []; });
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
$('#add-video-track').addEventListener('click', () => addTrack('video'));
$('#add-audio-track').addEventListener('click', () => addTrack('audio'));
$('#timeline-zoom-in').addEventListener('click', () => zoomTimeline(1));
$('#timeline-zoom-out').addEventListener('click', () => zoomTimeline(-1));
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

$('#inspector-collapse').addEventListener('click', () => $('#inspector-panel').classList.toggle('collapsed'));
$('#toggle-inspector').addEventListener('click', () => $('#inspector-panel').classList.toggle('collapsed'));
$('#toggle-media').addEventListener('click', () => { $('#bottom-dock').classList.toggle('media-collapsed'); $('#toggle-media').textContent = $('#bottom-dock').classList.contains('media-collapsed') ? '›' : '‹'; });
$('#toggle-timeline').addEventListener('click', () => { $('#bottom-dock').classList.toggle('timeline-collapsed'); $('#toggle-timeline').textContent = $('#bottom-dock').classList.contains('timeline-collapsed') ? '⌃' : '⌄'; });
$('#window-minimize').addEventListener('click', () => { if (tauriMode) getCurrentWindow().minimize(); });
$('#window-maximize').addEventListener('click', () => { if (tauriMode) getCurrentWindow().toggleMaximize(); else window.jupiterToast('Maximize is available in the desktop build.'); });
$('#window-close').addEventListener('click', () => { if (tauriMode) getCurrentWindow().close(); else window.jupiterToast('Close this browser tab to exit.'); });
$('#project-name').addEventListener('dblclick', () => { const name = prompt('Project name', app.project.name); if (name?.trim()) { pushUndo('Rename project'); setProjectName(name.trim()); } });

$('#png-input').addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
$('#media-input').addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
$('#audio-input').addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
$('#project-input').addEventListener('change', event => { if (event.target.files?.[0]) openProjectFromFile(event.target.files[0]); event.target.value = ''; });

const timelineBody = $('#timeline-body');
timelineBody.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('application/x-jupiter-asset')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
timelineBody.addEventListener('drop', event => {
  event.preventDefault(); const assetId = event.dataTransfer.getData('application/x-jupiter-asset');
  if (assetId) handleTimelineDrop(assetId, event.clientX, event.clientY);
});

const canvasWrap = $('#canvas-wrap');
canvasWrap.addEventListener('dragover', event => { if (event.dataTransfer.files?.length) { event.preventDefault(); canvasWrap.classList.add('drag-over'); } });
canvasWrap.addEventListener('dragleave', () => canvasWrap.classList.remove('drag-over'));
canvasWrap.addEventListener('drop', event => {
  event.preventDefault(); canvasWrap.classList.remove('drag-over');
  if (event.dataTransfer.files?.length) importFiles(event.dataTransfer.files, true);
});
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());

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
  // The liquid-glass-js library is an enhancement only. The CSS fallback remains active
  // when WebGL, html2canvas, or the CDN is unavailable (for example, offline use).
  try {
    if (typeof Container === 'undefined' || typeof html2canvas === 'undefined') return;
    const panels = ['.inspector', '.bottom-dock', '.commandbar'];
    for (const selector of panels) {
      const panel = $(selector); if (!panel || panel.dataset.liquidEnhanced) continue;
      const overlay = new Container({ borderRadius: 18, tintOpacity: .12 });
      overlay.element.style.position = 'absolute'; overlay.element.style.inset = '0';
      overlay.element.style.width = '100%'; overlay.element.style.height = '100%';
      overlay.element.style.padding = '0'; overlay.element.style.gap = '0';
      overlay.element.style.pointerEvents = 'none'; overlay.element.style.zIndex = '0';
      overlay.canvas.style.zIndex = '0'; overlay.canvas.style.boxShadow = 'none';
      panel.prepend(overlay.element);
      for (const child of [...panel.children]) if (child !== overlay.element) { child.style.position ||= 'relative'; child.style.zIndex = '1'; }
      panel.dataset.liquidEnhanced = 'true';
      const observer = new ResizeObserver(() => overlay.updateSizeFromDOM()); observer.observe(panel);
    }
  } catch (error) { console.info('Liquid glass enhancement skipped; CSS glass remains active.', error); }
}

renderAll();
setTimeout(initializeLiquidGlass, 450);
