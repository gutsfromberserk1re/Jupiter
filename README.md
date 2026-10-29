# PanelRun

PanelRun is a minimal Windows-native **frontend prototype** for an APK runtime experiment.

## Honest status

This project is **not yet an APK compatibility layer**. It provides a tiny Windows GUI for selecting an Android package, selecting a runtime executable, launching that executable, and showing basic status. It does not include ART, Android framework APIs, Android system services, graphics translation, or WebView.

An APK cannot run on Windows merely by opening it. WEBTOON may depend on Android's Java/Kotlin runtime, Android framework APIs, WebView, networking, storage, and app-specific compatibility behavior. Those components must be provided by a compatible runtime.

## Build (Windows)

1. Install Rust using <https://rustup.rs/>.
2. Install Visual Studio Build Tools with the **Desktop development with C++** workload.
3. Open PowerShell in this folder.
4. Run:

   ```powershell
   cargo run
   ```

5. Build an optimized executable:

   ```powershell
   cargo build --release
   ```

   Output: `target\\release\\panelrun.exe`

## Next engineering milestone

Before implementing an adapter, select and verify a backend whose source is available and whose license permits the intended use. Confirm:
- Windows x64 build works
- exact CLI syntax for APK installation/launch
- display/window integration
- required Android APIs and WebView behavior
- ARM64 translation support if needed

Do not assume that any experimental compatibility layer supports WEBTOON until the app is tested.

## License

The prototype source is MIT licensed. Any backend/runtime used alongside it has its own license and notices.
