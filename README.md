# Jupiter — 2D Animation Studio

Jupiter is a native desktop editor for importing raster artwork, drawing editable rigs over PNGs, posing joints, and animating both the rig and the artwork on a compact video-editor-style timeline.

## Stack

- **Rust + Tauri 2** for the native Windows desktop shell, project file dialogs, safe local file reads, and project persistence.
- **JavaScript + Canvas 2D** for the editing surface, mesh deformation, rig controls, timeline, interpolation graph, and playback.
- **HTML/CSS** for the white, softly frosted interface. The app does not load the Liquid Glass WebGL library or remote font/CDN assets.

## Features

### Workspace

- Single 2D canvas with transparency checkerboard, zoom and pan.
- Slim left toolbar: Select (`V`), Move (`M`), Rig (`R`), and Node (`N`).
- Right Inspector with values, keyframe controls, rig hierarchy, and the editable value graph in one continuous view.
- Media library in the right sidebar.
- Full-width bottom timeline with fixed track labels and horizontal frame scrolling.
- Collapsible tools, Inspector, Media panel, and timeline.

### PNG rigging

- Import PNG, WebP, and JPEG assets.
- Rig tool: click an image to create a root; drag from a joint to create a child joint and limb.
- Hold Shift while releasing on another joint to connect to that existing joint.
- Node tool moves existing joints only; it does not move the artwork or create new limbs.
- Select tool selects artwork or joints without moving them.
- Move tool transforms the artwork layer only.
- Basic CPU mesh deformation driven by the rig.

### Animation

- Auto Key is enabled by default.
- Animate joint X/Y, artwork position, scale, rotation, and opacity.
- Keyframe diamonds are shown inside image clips on the timeline.
- Scrub the ruler, drag keyframes, and edit curves in the Inspector graph.
- Linear, Ease, and Hold interpolation.
- Playback, pause, stop, frame stepping, and selectable frame rates.
- Audio playback is synchronized to the timeline during preview.

### Timeline

- V1 and A1 exist in a new project.
- V2/V3 and A2/A3 are created by dropping matching media onto temporary layer targets while dragging.
- Clips are magnetic and remain contiguous on each track.
- Drag clips between tracks of the same type and reorder them.
- Track labels remain pinned while the frame area scrolls horizontally.

### Projects and media

- Import media from the toolbar or Media panel; drag assets into the timeline.
- New, Open, Save, Save As, and Close Project through the Jupiter menu.
- `.jupiter` projects embed imported media as data URLs so the project is portable.
- Native file drops use the Rust backend to read local assets.
- Undo/redo history.

## Run on Windows

Requirements:

- Node.js 20 or later
- Rust stable toolchain
- Visual Studio Build Tools with the **Desktop development with C++** workload
- WebView2 Runtime (normally included with supported Windows versions)

Install dependencies and start the desktop app:

```powershell
npm install
npm test
npm run tauri dev
```

Build a Windows installer:

```powershell
npm run tauri build
```

The Tauri bundle is configured to produce NSIS and MSI installers.

## Shortcuts

| Shortcut | Action |
|---|---|
| `V` | Select tool |
| `M` | Move artwork tool |
| `R` | Rig tool |
| `N` | Node tool |
| `Space` | Play / pause |
| `←` / `→` | Previous / next frame |
| `Home` | Go to frame 0 |
| `K` via Add Key | Insert keyframe at playhead |
| `Ctrl+N` | New project |
| `Ctrl+O` | Open project |
| `Ctrl+S` | Save project |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` or `Ctrl+Shift+Z` | Redo |

## Current limitations

- Mesh deformation is a basic 12×12 CPU mesh with distance-weighted bone influences. It is not a full weight-painting or inverse-kinematics system yet.
- Curve interpolation is Linear, Ease, or Hold; there is no Bezier handle editor yet.
- Audio supports import and preview playback, but there is not yet a waveform renderer or final audio/video export pipeline.
- The canvas and graph are interactive; this is an early working foundation, not a finished commercial animation suite.

## Tests

Run the pure JavaScript core tests with:

```powershell
npm test
```
