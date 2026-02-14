use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use super::{err_to_string, PluginKind, PluginManifest, PluginImportRequest};

const ASR_ORT_PACKAGE_SCHEMA: &str = "dr-toru.asr.ort-package.v1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsrOrtImportPackage {
    schema: Option<String>,
    name: Option<String>,
    model_path: String,
    vocab_path: String,
}

fn sanitize_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for byte in value.bytes() {
        let mapped = match byte {
            b'A'..=b'Z' => (byte as char).to_ascii_lowercase(),
            b'a'..=b'z' | b'0'..=b'9' => byte as char,
            _ => '-',
        };
        if mapped == '-' {
            if last_dash {
                continue;
            }
            last_dash = true;
            slug.push(mapped);
            continue;
        }
        last_dash = false;
        slug.push(mapped);
    }
    slug.trim_matches('-').to_string()
}

fn now_suffix() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    millis.to_string()
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(err_to_string)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(err_to_string)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn copy_imported_asset(
    app: &AppHandle,
    plugin_id: &str,
    source: &Path,
) -> Result<(String, String, u64), String> {
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Invalid source file name: {}", source.display()))?;

    let relative_path = format!("plugins/assets/{plugin_id}/{file_name}");
    let app_data_dir = app.path().app_data_dir().map_err(err_to_string)?;
    let destination = app_data_dir.join(&relative_path);
    let Some(parent) = destination.parent() else {
        return Err("Invalid destination path".to_string());
    };
    fs::create_dir_all(parent).map_err(err_to_string)?;
    fs::copy(source, &destination).map_err(err_to_string)?;

    let hash = file_sha256(&destination)?;
    let size_bytes = fs::metadata(&destination).map_err(err_to_string)?.len();
    Ok((relative_path, hash, size_bytes))
}

fn onnx_vocab_candidate_names(stem: &str) -> Vec<String> {
    vec![
        format!("{stem}_vocab.json"),
        format!("{stem}.vocab.json"),
        "vocab.json".to_string(),
    ]
}

fn find_onnx_vocab_path(source: &Path) -> Option<PathBuf> {
    let stem = source.file_stem().and_then(|value| value.to_str())?;
    let parent = source.parent()?;
    onnx_vocab_candidate_names(stem)
        .into_iter()
        .map(|name| parent.join(name))
        .find(|candidate| candidate.exists() && candidate.is_file())
}

fn resolve_package_asset_path(package_file: &Path, value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Package asset path cannot be empty".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        let Some(base_dir) = package_file.parent() else {
            return Err("Package file has no parent directory".to_string());
        };
        base_dir.join(candidate)
    };

    if !resolved.exists() || !resolved.is_file() {
        return Err(format!("Package asset not found: {}", resolved.display()));
    }
    Ok(resolved)
}

fn load_asr_ort_package(source: &Path) -> Result<(Option<String>, PathBuf, PathBuf), String> {
    let raw = fs::read_to_string(source).map_err(err_to_string)?;
    let package: AsrOrtImportPackage = serde_json::from_str(&raw).map_err(err_to_string)?;

    if let Some(schema) = package.schema.as_ref() {
        if schema != ASR_ORT_PACKAGE_SCHEMA {
            return Err(format!(
                "Unsupported ASR package schema: {schema} (expected {ASR_ORT_PACKAGE_SCHEMA})"
            ));
        }
    }

    let model_path = resolve_package_asset_path(source, &package.model_path)?;
    let model_ext = model_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "Package modelPath must reference a .onnx file".to_string())?;
    if model_ext != "onnx" {
        return Err("Package modelPath must reference a .onnx file".to_string());
    }
    let vocab_path = resolve_package_asset_path(source, &package.vocab_path)?;

    Ok((
        package.name.filter(|value| !value.trim().is_empty()),
        model_path,
        vocab_path,
    ))
}

pub(super) fn imported_plugin_manifest(
    app: &AppHandle,
    request: &PluginImportRequest,
) -> Result<PluginManifest, String> {
    let source = PathBuf::from(request.source_path.trim());
    if !source.is_absolute() {
        return Err("sourcePath must be an absolute file path".to_string());
    }
    if !source.exists() || !source.is_file() {
        return Err(format!("File not found: {}", source.display()));
    }

    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "Imported file must have a valid extension".to_string())?;

    let source_stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("model")
        .to_string();

    let mut kind = PluginKind::Asr;
    let mut prefix = "import.asr";
    let mut display_name_fallback = source_stem.clone();
    let mut entrypoint_source = source.clone();
    let mut vocab_source: Option<PathBuf> = None;
    let mut metadata = None;

    if extension == "llamafile" {
        kind = PluginKind::Llm;
        prefix = "import.llm";
        metadata = Some(json!({
            "serviceStartArgs": ["--server", "--port", "{port}", "--nobrowser"],
            "serviceHealthPath": "/health",
            "serviceCompletionPath": "/completion"
        }));
    } else if extension == "onnx" {
        let Some(found_vocab) = find_onnx_vocab_path(&source) else {
            let expected = onnx_vocab_candidate_names(&source_stem).join(", ");
            return Err(format!(
                "Missing vocab file for ONNX import. Expected one of: {expected}"
            ));
        };
        vocab_source = Some(found_vocab);
    } else if extension == "asrpkg" {
        let (package_name, model_path, package_vocab_path) = load_asr_ort_package(&source)?;
        entrypoint_source = model_path;
        vocab_source = Some(package_vocab_path);
        if let Some(name) = package_name {
            display_name_fallback = name;
        } else if let Some(stem) = entrypoint_source.file_stem().and_then(|value| value.to_str()) {
            display_name_fallback = stem.to_string();
        }
    } else {
        return Err("Only .llamafile, .onnx, and .asrpkg imports are supported".to_string());
    }

    let slug = sanitize_slug(&source_stem);
    let slug = if slug.is_empty() {
        "model".to_string()
    } else {
        slug
    };
    let plugin_id = format!("{prefix}.{}.{}", slug, now_suffix());
    let (relative_entrypoint, file_hash, entrypoint_size_bytes) =
        copy_imported_asset(app, &plugin_id, &entrypoint_source)?;

    if kind == PluginKind::Asr {
        let vocab = vocab_source
            .as_ref()
            .ok_or_else(|| "ASR import requires a vocab file".to_string())?;
        let (relative_vocab_path, vocab_hash, _) = copy_imported_asset(app, &plugin_id, vocab)?;
        metadata = Some(json!({
            "vocabPath": relative_vocab_path,
            "vocabSha256": vocab_hash
        }));
    }

    let installed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();

    Ok(PluginManifest {
        plugin_id,
        name: request
            .display_name
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(display_name_fallback),
        version: "1.0.0".to_string(),
        kind,
        entrypoint_path: relative_entrypoint,
        sha256: file_hash,
        model_family: None,
        size_bytes: Some(entrypoint_size_bytes),
        license: None,
        installed_at: Some(installed_at),
        metadata,
    })
}

pub(super) fn imported_asset_dir(
    app: &AppHandle,
    manifest: &PluginManifest,
) -> Result<Option<PathBuf>, String> {
    let prefix = format!("plugins/assets/{}/", manifest.plugin_id);
    if !manifest.entrypoint_path.starts_with(&prefix) {
        return Ok(None);
    }

    let app_data = app.path().app_data_dir().map_err(err_to_string)?;
    Ok(Some(
        app_data
            .join("plugins")
            .join("assets")
            .join(&manifest.plugin_id),
    ))
}
