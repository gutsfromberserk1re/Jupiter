use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::fs;
use tauri::{path::BaseDirectory, AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedAsset {
    name: String,
    mime: String,
    data_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegStatus {
    available: bool,
    ffprobe_available: bool,
    version: Option<String>,
    ffmpeg_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaProbe {
    duration: f64,
    width: u32,
    height: u32,
    has_audio: bool,
    has_video: bool,
    format_name: String,
}

fn media_mime_from_extension(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "tif" | "tiff" => Some("image/tiff"),
        "avif" => Some("image/avif"),
        "svg" => Some("image/svg+xml"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "flac" => Some("audio/flac"),
        "ogg" | "oga" => Some("audio/ogg"),
        "opus" => Some("audio/opus"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "aif" | "aiff" => Some("audio/aiff"),
        "wma" => Some("audio/x-ms-wma"),
        "mid" | "midi" => Some("audio/midi"),
        _ => None,
    }
}

#[tauri::command]
fn save_project(path: String, contents: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create project folder: {e}"))?;
    }
    fs::write(&target, contents).map_err(|e| format!("Could not save project: {e}"))
}

#[tauri::command]
fn load_project(path: String) -> Result<String, String> {
    fs::read_to_string(PathBuf::from(path)).map_err(|e| format!("Could not open project: {e}"))
}

#[tauri::command]
fn read_asset(path: String) -> Result<ImportedAsset, String> {
    let file_path = PathBuf::from(&path);
    let bytes = fs::read(&file_path).map_err(|e| format!("Could not read asset: {e}"))?;
    let guessed = mime_guess::from_path(&file_path).first_or_octet_stream();
    let mime = if guessed.essence_str() == "application/octet-stream" {
        media_mime_from_extension(&file_path).unwrap_or("application/octet-stream")
    } else {
        guessed.essence_str()
    }.to_string();
    let name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("imported-asset")
        .to_string();
    Ok(ImportedAsset {
        name,
        mime,
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

fn tool_file_name(name: &str) -> String {
    if cfg!(target_os = "windows") { format!("{name}.exe") } else { name.to_string() }
}

fn resolve_tool(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let filename = tool_file_name(name);
    if let Ok(path) = app.path().resolve(format!("ffmpeg/{filename}"), BaseDirectory::Resource) {
        if path.is_file() { return Some(path); }
    }

    // Development fallback: scripts/setup-ffmpeg.ps1 populates this directory.
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("ffmpeg")
        .join(&filename);
    if dev_path.is_file() { return Some(dev_path); }

    // Permit a system FFmpeg installation during development or if a user has
    // deliberately removed the bundled runtime.
    let command_name = tool_file_name(name);
    let available = Command::new(&command_name)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if available { Some(PathBuf::from(command_name)) } else { None }
}

fn command_output(program: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("Could not launch {}: {error}", program.display()))
}

fn output_text(output: &Output) -> String {
    if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    } else {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }
}

#[tauri::command]
fn ffmpeg_status(app: AppHandle) -> FfmpegStatus {
    let ffmpeg = resolve_tool(&app, "ffmpeg");
    let ffprobe = resolve_tool(&app, "ffprobe");
    let version = ffmpeg.as_ref().and_then(|path| {
        command_output(path, &["-hide_banner", "-version"]).ok().map(|output| {
            output_text(&output).lines().next().unwrap_or("FFmpeg available").to_string()
        })
    });
    FfmpegStatus {
        available: ffmpeg.is_some(),
        ffprobe_available: ffprobe.is_some(),
        version,
        ffmpeg_path: ffmpeg.map(|path| path.display().to_string()),
    }
}

#[tauri::command]
fn probe_media(app: AppHandle, path: String) -> Result<MediaProbe, String> {
    let ffprobe = resolve_tool(&app, "ffprobe")
        .ok_or_else(|| "FFprobe is not installed. Run npm run setup:ffmpeg first.".to_string())?;
    let output = Command::new(&ffprobe)
        .args([
            "-v", "error",
            "-show_entries", "format=duration,format_name:stream=codec_type,width,height",
            "-of", "json",
            &path,
        ])
        .output()
        .map_err(|error| format!("Could not launch FFprobe: {error}"))?;
    if !output.status.success() {
        return Err(format!("FFprobe could not read this file: {}", output_text(&output)));
    }
    let json: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("FFprobe returned invalid metadata: {error}"))?;
    let duration = json["format"]["duration"].as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .or_else(|| json["format"]["duration"].as_f64())
        .unwrap_or(0.0);
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter().find(|stream| stream["codec_type"] == "video");
    let has_audio = streams.iter().any(|stream| stream["codec_type"] == "audio");
    Ok(MediaProbe {
        duration,
        width: video.and_then(|stream| stream["width"].as_u64()).unwrap_or(0) as u32,
        height: video.and_then(|stream| stream["height"].as_u64()).unwrap_or(0) as u32,
        has_audio,
        has_video: video.is_some(),
        format_name: json["format"]["format_name"].as_str().unwrap_or("").to_string(),
    })
}

fn supports_encoder(ffmpeg: &Path, encoder: &str) -> bool {
    let output = command_output(ffmpeg, &["-hide_banner", "-encoders"]);
    output.map(|result| {
        result.status.success() && output_text(&result).lines().any(|line| {
            line.split_whitespace().any(|field| field == encoder)
        })
    }).unwrap_or(false)
}

fn run_png_sequence_export(
    ffmpeg: &Path,
    frames_dir: &Path,
    output_path: &Path,
    fps: u32,
    audio_path: Option<&Path>,
    video_encoder: &str,
) -> Result<(), String> {
    let first_zero = frames_dir.join("frame_000000.png");
    let first_one = frames_dir.join("frame_000001.png");
    let (start_number, first_frame) = if first_zero.is_file() { ("0", first_zero) } else { ("1", first_one) };
    if !first_frame.is_file() {
        return Err(format!("No frame_000000.png or frame_000001.png found in {}", frames_dir.display()));
    }
    if let Some(parent) = output_path.parent().filter(|path| !path.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|error| format!("Could not create export folder: {error}"))?;
    }
    let pattern = frames_dir.join("frame_%06d.png");
    let mut command = Command::new(ffmpeg);
    command.args(["-y", "-hide_banner", "-loglevel", "error", "-framerate"])
        .arg(fps.to_string())
        .arg("-start_number")
        .arg(start_number)
        .arg("-i")
        .arg(pattern);
    if let Some(audio) = audio_path {
        if audio.is_file() { command.arg("-i").arg(audio); }
    }
    command.args(["-c:v", video_encoder, "-pix_fmt", "yuv420p"]);
    if video_encoder == "mpeg4" {
        command.args(["-q:v", "2"]);
    } else {
        command.args(["-b:v", "12M"]);
    }
    if audio_path.is_some_and(|path| path.is_file()) {
        command.args(["-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "192k", "-shortest"]);
    } else {
        command.arg("-an");
    }
    command.args(["-movflags", "+faststart"]).arg(output_path);
    let output = command.output().map_err(|error| format!("Could not launch FFmpeg: {error}"))?;
    if output.status.success() { Ok(()) }
    else { Err(output_text(&output)) }
}

/// Converts `frames/frame_000000.png`... into an MP4. Windows uses Media
/// Foundation H.264 when provided by the FFmpeg build, with MPEG-4 Part 2 as
/// a compatibility fallback. AAC audio is included when an audio path exists.
#[tauri::command]
fn export_png_sequence_to_mp4(
    app: AppHandle,
    frames_directory: String,
    output_path: String,
    fps: u32,
    audio_path: Option<String>,
) -> Result<String, String> {
    if !(1..=240).contains(&fps) { return Err("FPS must be between 1 and 240.".to_string()); }
    let ffmpeg = resolve_tool(&app, "ffmpeg")
        .ok_or_else(|| "FFmpeg is not installed. Run npm run setup:ffmpeg first.".to_string())?;
    let frames_dir = PathBuf::from(frames_directory);
    let output = PathBuf::from(output_path);
    let audio = audio_path.map(PathBuf::from);
    let encoder = if supports_encoder(&ffmpeg, "h264_mf") { "h264_mf" } else { "mpeg4" };
    match run_png_sequence_export(&ffmpeg, &frames_dir, &output, fps, audio.as_deref(), encoder) {
        Ok(()) => Ok(format!("MP4 exported using {encoder}.")),
        Err(first_error) if encoder == "h264_mf" => {
            run_png_sequence_export(&ffmpeg, &frames_dir, &output, fps, audio.as_deref(), "mpeg4")
                .map(|()| "MP4 exported using the MPEG-4 compatibility encoder.".to_string())
                .map_err(|fallback_error| format!("H.264 export failed: {first_error}\nMPEG-4 fallback failed: {fallback_error}"))
        }
        Err(error) => Err(format!("MP4 export failed: {error}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_project,
            load_project,
            read_asset,
            ffmpeg_status,
            probe_media,
            export_png_sequence_to_mp4,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jupiter");
}

fn main() {
    run();
}
