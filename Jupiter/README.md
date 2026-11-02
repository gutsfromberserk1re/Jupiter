# Jupiter · 2D Animation Studio

Jupiter is a desktop-first PNG rigging and animation editor built with **Rust + Tauri 2** for native file access and **vanilla JavaScript + Canvas 2D** for the interactive workspace.

The goal is deliberately focused: import an image, create a joint-and-bone rig, pose it with automatic keyframes, and arrange image/audio clips on a magnetic timeline.

## Interface

- One canvas workspace; no separate 2D/3D modes.
- A narrow, collapsible left tool rail: Select (`V`), Move (`M`), Rig (`R`) and Node (`N`).
- Right Inspector with **Values** and **Media** tabs. Media lives here, not in a separate bottom dock.
- A full-width timeline along the bottom; both the timeline and Inspector can collapse independently.
- White-tinted frosted surfaces, lightly rounded corners, restrained shadows and no neon/glow styling.
- The supplied [`liquid-glass-js`](https://github.com/dashersw/liquid-glass-js) library is used as a subtle white frosting enhancement for the major panels. Jupiter keeps a CSS fallback if WebGL or the network is unavailable.

## Tools

| Tool | Shortcut | Behaviour |
|---|---|---|
| Select | `V` | Select the artwork layer or a joint. It does not drag either. |
| Move | `M` | Move the selected image layer without changing its rig. |
| Rig | `R` | Drag from an existing joint to create a new limb and endpoint. Hold Shift to connect to an existing joint. Clicking artwork creates a root joint. |
| Node | `N` | Move existing rig joints only. It never moves the image or creates bones. Joints can extend slightly beyond the PNG bounds. |

The tools rail, Inspector and timeline each have their own collapse control. The custom title bar supports window dragging and the red/yellow/green close, minimize and maximize controls.

The rig is editable through the canvas and the Inspector hierarchy. Joint movement uses Auto Key by default, so posing at a different frame creates or updates a keyframe rather than moving the artwork itself.

## Timeline

- Starts with **V1** and **A1** only.
- **V2/V3** are offered temporarily while dragging image media; **A2/A3** are offered while dragging audio media. Only the matching type's drop target appears.
- A maximum of three video and three audio layers is supported.
- Clips on each track are magnetic and contiguous; moving a clip reorders the sequence rather than leaving gaps.
- Video layers composite V1 (back) through V3 (front). Audio clips are played during timeline playback.
- Scrub on the ruler, click/drag clips to reorder, and drag diamond keyframes to retime them.
- Keyframes appear inside their clip lane; property types use small vertical offsets so keys at the same frame remain individually visible.
- The Inspector's Values tab includes per-property key buttons and a value graph. Graph keys can be dragged in time and value and use Linear, Ease or Hold interpolation.
- Auto Key records joint X/Y poses and image Position X/Y, Rotation, Scale and Opacity at the current clip-local frame.

## Media and projects

- Import PNG, JPEG and WebP images and common browser-supported audio files.
- Drag media from the Inspector's Media tab onto V1/A1 or a temporary layer target.
- Double-click a media card to append it to its matching first track.
- Save/Open/New project uses portable `.jupiter` JSON files with media embedded as data URLs.
- Browser preview falls back to JSON file download/upload; desktop builds use Rust file commands and the Tauri dialog plugin.

## Shortcuts

| Shortcut | Action |
|---|---|
| `V` | Select |
| `M` | Move artwork |
| `R` | Rig |
| `N` | Node |
| `Space` | Play / pause |
| `←` / `→` | Previous / next frame |
| `Home` | Go to first frame |
| `Ctrl+N` | New project |
| `Ctrl+O` | Open project |
| `Ctrl+S` | Save project |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` or `Ctrl+Shift+Z` | Redo |
| `Delete` | Delete selected joint or clip |

## Development

Requirements:
- Node.js 20 or newer
- Rust stable toolchain
- Tauri 2 prerequisites for your platform
- On Windows, Microsoft C++ Build Tools and WebView2 Runtime

```bash
npm install
npm test
npm run tauri dev
```

Build Windows installers:

```bash
npm run tauri build
```

The included GitHub Actions workflow builds Windows NSIS/MSI installers and uploads bundle artifacts.

## Current scope and limitations

- Rig deformation is a CPU-side 2D linear-blend mesh pass with a 12×12 grid. It is a first implementation, not full automatic weight painting or inverse kinematics.
- Joint and transform curves support Linear, Ease and Hold interpolation. Editable Bezier handles are not implemented yet.
- Audio is played during preview, but audio waveforms and video export are not included yet.
- The liquid-glass enhancement uses pinned upstream CDN scripts and the CSS fallback remains available offline. The upstream library is MIT licensed; its license is included at `assets/LiquidGlass-LICENSE.txt`.

Jupiter's canvas, rigging, timeline, project model and Rust commands are original project code.
