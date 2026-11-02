Jupiter Inspector + Window Controls Patch

Extract this ZIP directly into the Jupiter project directory containing package.json.
It replaces only:
  index.html
  src/main.js
  src-tauri/capabilities/default.json

Changes:
- Transform and Graph remain together in the Values Inspector view; Graph is placed directly below Transform.
- The Inspector keeps one top-level Values / Media tab bar. There is no Media sub-tab in the Graph section.
- Node tool icon is a cursor with a short stem ending at a node point.
- Adds required Tauri v2 window permissions for close, minimize, toggle-maximize, and start-dragging.
- Native window action failures now show a user-visible toast.

No rigging, media, animation, or timeline algorithms were changed.
