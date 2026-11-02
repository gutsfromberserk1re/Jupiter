use base64::Engine;
use serde::Serialize;
use std::{fs, path::PathBuf};

#[derive(Serialize)]
struct ImportedAsset {
    name: String,
    mime: String,
    data_base64: String,
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
    let mime = mime_guess::from_path(&file_path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_project, load_project, read_asset])
        .run(tauri::generate_context!())
        .expect("error while running Jupiter");
}

fn main() {
    run();
}
