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

Open the **Media** tab in the right Inspector. Double-click or right-click its empty area to import; you can also drop files onto the Media panel. Import PNG, JPEG, WebP and browser-supported audio formats. Double-click an imported asset to append it to its first matching track, or drag it onto a timeline track.

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
- The custom title bar supports dragging, double-click maximize/restore, minimize, maximize/restore and close in the Tauri desktop app.
- The export icon is a visual placeholder; final video export is not implemented yet.

## Run on Windows

Requirements:
- Node.js 20 or newer
- Rust stable + Cargo
- Tauri 2 Windows prerequisites (Microsoft C++ Build Tools and WebView2 Runtime)

For the native desktop app, extract the project and double-click `run-jupiter-dev.bat`, or run:

```powershell
npm install
npm test
npm run check
npm run tauri dev
```

To build NSIS/MSI installers:

```powershell
npm run tauri build
```

For a browser-only UI/interaction preview without the Rust shell, double-click `run-web-preview.bat` or run `npm run dev`, then open `http://127.0.0.1:1420`.

The `.github/workflows/build-windows.yml` workflow builds Windows installers and uploads them as workflow artifacts. Rust dependency outputs are cached between CI runs.

## Current implementation limits

- Rig deformation is a CPU-side 2D linear-blend mesh pass using a 12×12 grid. This is a first implementation, not full automatic weight painting or inverse kinematics.
- Curves support Linear, Ease and Hold interpolation. Full Bezier tangent handles are not implemented.
- Audio plays during preview, but audio waveforms and final MP4/GIF/PNG-sequence export are not implemented yet.
