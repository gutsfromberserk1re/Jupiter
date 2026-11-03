# Jupiter 0.2.1 — Skeletal Skinning Polish

This release refines the 0.2 skinning workflow without changing Jupiter's overall workspace layout.

## What's improved


- A subtle blue influence preview, clipped to PNG transparency and deformed with the current pose.
- More predictable Smooth painting: every stroke reads from a stable weight snapshot and blends all influences.
- Automatic image-aspect correction for the paint brush.
- Weight validation for stale bone IDs, incomplete grids and intentionally empty vertices.
- Faster mesh cache validation using a per-rig weight revision instead of serializing the entire weight grid every frame.
- Clearer painting controls with radius/strength readouts and an accessible toggle state.
- Frontend, Tauri and Cargo package versions aligned at 0.2.1.

## Verify

```powershell
npm test
npm run check
npm run build
```

The automated Node test suite and JavaScript syntax checks pass in the supplied source. A Vite production build and native Windows build were not verified in the packaging environment because npm dependency installation did not complete.
