# Jupiter — 2D Animation Studio

Jupiter is a native desktop editor for rigging and animating imported 2D artwork. The UI is built with HTML, CSS and vanilla JavaScript; the native desktop shell and file operations use Rust + Tauri 2.

## Workspace

- A permanent, slim **left tool rail** with Select, Move, Rig and Node tools.
- A central transparent checkerboard 2D canvas.
- A right Inspector with **Values** and **Media** tabs. Values places transform/key controls beside the animation graph; Media is the import/library surface.
- A full-width, solid timeline along the bottom.
- A slate-gray app surround with translucent white frosted panels. No neon glow or external Liquid Glass runtime.

## Tools

| Tool | Shortcut | Behaviour |
|---|---|---|
| Select | `V` | Selects artwork or a rig joint without dragging either. |
| Move | `M` | Moves the selected artwork layer only. |
| Rig | `R` | Drag from an existing joint to create a limb and endpoint. Hold Shift to connect to an existing joint. Starting on artwork with no rig creates its root joint. |
| Node | `N` | Moves existing rig joints only. It does not create bones or move the artwork. |

The Node icon is a cursor with a stem and endpoint. The tool rail is always visible unless deliberately collapsed with the small canvas-side chevron. Pan the canvas with middle-mouse drag or Alt+drag.

## Media

Open the **Media** tab in the right Inspector and press **Add media**, or drop files directly into the panel. The picker supports multiple files in one selection. Import PNG, JPEG, WebP, GIF, BMP, TIFF, AVIF, SVG, common audio formats and MIDI (including MP3, WAV, FLAC, OGG/Opus, M4A and AAC). Imported media cards can be dragged onto V1/A1 (and temporary V2/V3 or A2/A3 targets); Jupiter uses a pointer-driven drag ghost so internal media-to-timeline dragging works reliably in WebView2. Double-click a media card to append it to its first matching track.

## Animation

- Auto Key is enabled by default.
- Joint positions and artwork Position X/Y, Rotation, Scale and Opacity can be keyframed.
- Keyframe diamonds are displayed on the corresponding timeline clip.
- The Values area includes property key controls and previous/next keyframe navigation.
- The Graph Editor sits beside Values controls and allows key points to be moved in time/value. Linear, Ease and Hold interpolation are supported.
- Playback, pause, stop, frame stepping and FPS selection are available.
- Undo/redo are available from the toolbar and keyboard.

## Timeline

- V1 and A1 are visible in a new project.
- V2/V3 and A2/A3 appear as drop targets while dragging matching media or moving a clip into a new lane.
- Clips on a track are magnetic and contiguous; dragging reorders clips without leaving gaps.
- Video tracks composite from V1 through V3. Audio clips play during preview.

## Projects and desktop window

- New, Open, Save and Save As use portable `.jupiter` project files with media embedded.
- The custom title bar supports dragging and double-click maximize/restore. The traffic-light controls are green=minimize, yellow=maximize/restore and red=close.
- Export opens a save dialog and renders the timeline to MP4, including the timeline audio mix.

## Run on Windows

Requirements:
- Node.js 20 or newer
- Rust stable + Cargo
- Tauri 2 Windows prerequisites (Microsoft C++ Build Tools and WebView2 Runtime)

For the native desktop app, extract the project and double-click `run-jupiter-dev.bat`, or run:

```powershell
npm install
npm run setup:ffmpeg
npm test
npm run check
npm run tauri dev
```

To build NSIS/MSI installers:

```powershell
npm run setup:ffmpeg
npm run tauri build
```

For a browser-only UI/interaction preview without the Rust shell, double-click `run-web-preview.bat` or run `npm run dev`, then open `http://127.0.0.1:1420`.

The Windows desktop build uses FFmpeg 9.0.2 and FFprobe from an LGPL shared build. `run-jupiter-dev.bat` and the GitHub Actions workflows run `npm run setup:ffmpeg` automatically; for a manual build, run that command before `npm run tauri dev` or `npm run tauri build`. The workflows publish a standalone `jupiter.exe` test build with its `ffmpeg` runtime folder beside it, without creating an installer. Local `npm run tauri build` still creates the configured NSIS/MSI installers. See `FFMPEG-NOTICE.md` for licensing and upstream details. Rust dependency outputs are cached between CI runs.

## Current implementation limits

- Rig deformation is a CPU-side 2D linear-blend mesh pass using a 24×24 normalized weight grid. This is an initial 2D skinning system; it is not a contour-aware editable mesh or inverse kinematics system.
- Curves support Linear, Ease and Hold interpolation. Full Bezier tangent handles are not implemented.
- FFprobe reads media duration/stream metadata. MP4 export renders at the current canvas preview size; export resolution/codec controls and audio waveforms are not implemented yet.


## Skinning

Each rig stores normalized bone influences on a 24×24 grid, generated **automatically** from the bone layout and kept with the artwork when its resolution changes. The renderer samples the grid bilinearly and blends per-bone 2D transforms. There is no weight painting or brush tooling; weights regenerate whenever the rig topology changes.

Run verification with:

```powershell
npm test
npm run check
npm run build
```
