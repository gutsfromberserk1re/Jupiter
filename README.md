# Jupiter · 2D Animation Studio

Jupiter is a desktop-first PNG rigging and animation editor built with **Rust + Tauri 2** for native project/file access and **vanilla JavaScript + Canvas 2D** for the interactive workspace. The first release is focused on one thing: importing an image, drawing a lightweight bone rig, posing its joints, and arranging image/audio clips on a magnetic timeline.

## Interface direction

- Single preview/canvas workspace; no separate 2D/3D modes.
- Left editing tools: Select (`V`), Rig (`R`), Node (`N`).
- Right Inspector with Values and Media tabs.
- Bottom Media bin and timeline with video/audio lanes.
- Collapsible Inspector, Media bin and Timeline.
- Dark midnight-blue foundation with translucent cyan glass panels, bright edge highlights and subtle texture.
- The supplied `liquid-glass-js` library is loaded from jsDelivr as an optional WebGL enhancement for the major panels. The CSS glass treatment remains when the CDN/WebGL is unavailable.

## Current interactions

### Media and timeline
- Import PNG/JPEG/WebP images and audio files into the Media bin.
- Double-click a Media item to append it to its matching timeline track.
- Drag a Media item onto the timeline to insert it at a magnetic position.
- Drag clips within/between matching track types to reorder them. Clips on a track are laid contiguously; there are no empty gaps.
- The active video clip at the playhead is shown in the preview.
- Add video and audio tracks with the controls in the Media bin.

### Rigging
- Select an image clip and choose Rig (`R`).
- Drag from an existing joint to create a new limb and joint.
- Hold Shift while ending a drag on an existing joint to connect to that joint.
- Clicking empty artwork creates a root joint (or a new disconnected root when the rig already has joints).
- Node (`N`) only moves existing joints; it does not create bones.
- Select (`V`) selects the artwork or a joint without changing rig topology.
- Joints and limbs are drawn as editable vector overlays. The PNG is deformed through a lightweight CPU mesh skinning pass.

### Animation
- Moving a joint with Node (`N`) creates or updates a keyframe at the current clip-local frame.
- Artwork Position X/Y, Rotation, Scale and Opacity are animated too; changing a value in the Inspector auto-keys it at the playhead.
- The **◆ Key** command inserts the current pose and all artwork transform values at once.
- The timeline displays separate layer-transform and joint lanes with diamond keyframes. Drag a diamond to retime it; duplicate keys at the same frame are merged.
- Joint and layer values interpolate linearly between keys.
- Scrub from the time ruler or the timeline lanes; Space plays/pauses and the arrow keys step one frame.
- The active image clip under the playhead is selected automatically as playback/scrubbing crosses clip boundaries.

### Projects
- New, Open, Save and Save As use `.jupiter` JSON project files.
- Imported media is embedded as data URLs so projects remain portable.
- Native builds use Rust commands for file access and the Tauri dialog plugin.
- Browser preview supports JSON download/upload as a fallback.

## Shortcuts

| Shortcut | Action |
|---|---|
| `V` | Select tool |
| `R` | Rig tool |
| `N` | Node tool |
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
- On Windows, the Microsoft C++ Build Tools and WebView2 Runtime

Run the dependency-free core tests and install dependencies:

```bash
npm test
npm install
npm run dev
```

Run the desktop app:

```bash
npm run tauri dev
```

Build Windows installers:

```bash
npm run tauri build
```

The included GitHub Actions workflow builds Windows NSIS/MSI installers and uploads the bundle artifacts.

## Notes / first-iteration scope

- The rig uses 2D linear-blend mesh deformation with a modest 12×12 grid. This is an editable first pass, not yet a full weight-painting or IK system.
- Joint positions and artwork transforms are currently linearly interpolated. Bezier/step interpolation, graph handles, onion skinning, mesh weight painting, multi-selection, ripple trimming and MP4 export are later milestones.
- The glass effect is an optional visual enhancement. It needs WebGL 1 and a network connection for CDN-loaded scripts; the CSS fallback does not.
- No audio waveform rendering or video encoding is included yet. Audio clips can be arranged and previewed during playback.

## Third-party component

`dashersw/liquid-glass-js` is MIT licensed and is loaded from pinned upstream CDN URLs in `index.html` ([source repository](https://github.com/dashersw/liquid-glass-js)). Its license is reproduced in `assets/LiquidGlass-LICENSE.txt`. Jupiter's canvas, rigging, timeline, project model and Rust commands are original project code.
