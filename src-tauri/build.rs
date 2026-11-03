use std::{env, fs, path::{Path, PathBuf}};

fn collect_runtime_files(root: &Path, directory: &Path, files: &mut Vec<(String, PathBuf)>) -> std::io::Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect_runtime_files(root, &path, files)?;
        } else if kind.is_file() && entry.file_name() != std::ffi::OsStr::new(".gitkeep") {
            let relative = path.strip_prefix(root).expect("FFmpeg file is inside its resource directory");
            files.push((relative.to_string_lossy().replace('\\', "/"), path));
        }
    }
    Ok(())
}

fn runtime_fingerprint(files: &[(String, PathBuf)]) -> std::io::Result<u64> {
    let mut hash = 0xcbf29ce484222325_u64;
    for (name, path) in files {
        for byte in name.as_bytes().iter().copied().chain(std::iter::once(0)) {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
        }
        for byte in fs::read(path)? {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
        }
    }
    Ok(hash)
}

fn embed_ffmpeg_runtime() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo sets CARGO_MANIFEST_DIR"));
    let resource_dir = manifest.join("resources").join("ffmpeg");
    println!("cargo:rerun-if-changed={}", resource_dir.display());

    let mut files = Vec::new();
    if resource_dir.is_dir() {
        collect_runtime_files(&resource_dir, &resource_dir, &mut files)?;
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let fingerprint = runtime_fingerprint(&files)?;

    let mut generated = format!("pub const RUNTIME_FINGERPRINT: &str = \"{fingerprint:016x}\";\npub static FILES: &[(&str, &[u8])] = &[\n");
    for (relative, source) in files {
        println!("cargo:rerun-if-changed={}", source.display());
        generated.push_str(&format!(
            "    ({relative:?}, include_bytes!({source:?}) as &[u8]),\n",
            source = source.to_string_lossy(),
        ));
    }
    generated.push_str("];\n");

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"))
        .join("embedded_ffmpeg.rs");
    fs::write(output, generated)?;
    Ok(())
}

fn main() {
    tauri_build::build();
    embed_ffmpeg_runtime().expect("Could not embed the FFmpeg runtime");
}
