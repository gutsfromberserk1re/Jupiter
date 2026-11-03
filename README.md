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
- V2/V3 and A2/A3 appear as drop targets only while dragging matching media.
- Clips on a track are magnetic and contiguous; dragging reorders clips without leaving gaps.
- Video tracks composite from V1 through V3. Audio clips play during preview.

## Projects and desktop window

- New, Open, Save and Save As use portable `.jupiter` project files with media embedded.
- The custom title bar supports dragging and double-click maximize/restore. The traffic-light controls are green=minimize, yellow=maximize/restore and red=close.
- The export icon is a visual placeholder; final video export is not implemented yet.

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

The Windows desktop build bundles FFmpeg 9.0.2 and FFprobe from an LGPL shared build. `run-jupiter-dev.bat` and the GitHub Actions workflow run `npm run setup:ffmpeg` automatically; for a manual build, run that command before `npm run tauri dev` or `npm run tauri build`. The setup downloads the executables and their runtime DLLs into `src-tauri/resources/ffmpeg/`; Tauri includes that directory in the Windows installers. See `FFMPEG-NOTICE.md` for licensing and upstream details. Rust dependency outputs are cached between CI runs.

## Current implementation limits

- Rig deformation is a CPU-side 2D linear-blend mesh pass using a 24×24 normalized weight grid. This is an initial 2D skinning system; it is not a contour-aware editable mesh or inverse kinematics system.
- Curves support Linear, Ease and Hold interpolation. Full Bezier tangent handles are not implemented.
- FFprobe reads media duration/stream metadata, and the Rust backend includes a PNG-sequence-to-MP4 FFmpeg command. A finished export dialog/UI and audio waveforms are not implemented yet.


## Jupiter 0.2.1 — Skeletal skinning polish

Jupiter 0.2.1 polishes the persistent mesh skin weights introduced in 0.2. Each image rig stores normalized bone influences on a 24×24 normalized vertex grid, so weights remain attached to the artwork when its source resolution changes. The renderer samples the weight grid bilinearly and blends per-bone 2D transforms. A revision-based render cache avoids re-serializing the full weight grid on every animation frame.

### Weight painting

1. Import an image and place it on the timeline.
2. Create a rig with at least one bone.
3. In Values, open **Skinning · 0.2.1**. Choose an influence bone and enable Weight painting.
4. Paint directly on the artwork with the Node tool. Add, Subtract, and Smooth modes are available, along with aspect-correct brush radius and strength. Smoothing reads from a stable snapshot so the result is not biased by brush traversal order.
5. Adjust brush radius and strength as needed. The live brush outline reflects the source image proportions, and the blue overlay previews the selected bone's influence on the artwork. Use **Regenerate auto weights** to rebuild distance-based influences, or **Normalize** to remove invalid bone IDs and normalize the stored vertices.

Weights are stored inside the `.jupiter` project alongside the rig. Changing the rig topology invalidates old weights so the next render can generate a matching set. Existing projects without weights are upgraded automatically when their rig is rendered.


### 0.2.1 polish notes

- Live brush outline follows the image's width/height ratio.
- Smooth painting blends all bone influences from an immutable stroke snapshot.
- Weight validation removes stale bone IDs, repairs missing grid cells and preserves intentionally empty vertices.
- Mesh cache keys use a weight revision counter rather than serializing the entire weight grid every frame.
- Painting controls include visible value readouts and accessible toggle state.

Run verification with:

```powershell
npm test
npm run check
npm run build
```
