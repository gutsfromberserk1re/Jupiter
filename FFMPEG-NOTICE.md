# FFmpeg runtime notice

Jupiter downloads and bundles the Windows x86-64 **LGPL shared** build of FFmpeg 9.0.2 from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), pinned to the
`autobuild-2026-11-01-12-49` build (`gd7643a0fe3`). The build asset is the
`ffmpeg-n9.0.2-42-gd7643a0fe3-win64-lgpl-shared-9.0.zip` archive. The setup script places
`ffmpeg.exe`, `ffprobe.exe`, all adjacent runtime DLLs, and upstream license/readme files in
`src-tauri/resources/ffmpeg/`; the Windows installer includes that directory.

The shared LGPL variant keeps FFmpeg's libraries replaceable as DLLs. The exact upstream
license/readme files are copied beside the executables during setup. Do not substitute a GPL
or nonfree build without reviewing the resulting licensing obligations.

- FFmpeg project: https://ffmpeg.org/
- FFmpeg license overview: https://ffmpeg.org/legal.html
- FFmpeg 9.0.2 source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
- BtbN build source and recipes: https://github.com/BtbN/FFmpeg-Builds
- Pinned build release: https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-11-01-12-49

Jupiter uses FFmpeg/FFprobe as child processes from its Rust backend. FFprobe supplies media
duration and stream metadata. The MP4 sequence-export command prefers Media Foundation H.264
(`h264_mf`) when available and falls back to FFmpeg's MPEG-4 Part 2 encoder. AAC audio is
encoded with FFmpeg's built-in AAC encoder. The UI export dialog is not yet wired up.
