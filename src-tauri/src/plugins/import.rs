use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use super::{err_to_string, PluginImportRequest, PluginKind, PluginManifest};

const ASR_ORT_PACKAGE_SCHEMA: &str = "dr-toru.asr.ort-package.v1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsrOrtImportPackage {
    schema: Option<String>,
    name: Option<String>,
    model_path: String,
    vocab_path: String,
    lm_path: Option<String>,
    kenlm_wasm_path: Option<String>,
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

/// Copy a file while computing its SHA256 in a single pass.
/// Emits "plugin-import-progress" events so the frontend can show progress.
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

    let total_bytes = fs::metadata(source).map_err(err_to_string)?.len();
    let mut src_file = File::open(source).map_err(err_to_string)?;
    let mut dst_file = File::create(&destination).map_err(err_to_string)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 256 * 1024];
    let mut copied: u64 = 0;
    let mut last_emit = Instant::now();

    loop {
        let n = src_file.read(&mut buffer).map_err(err_to_string)?;
        if n == 0 {
            break;
        }
        dst_file.write_all(&buffer[..n]).map_err(err_to_string)?;
        hasher.update(&buffer[..n]);
        copied += n as u64;

        // Throttle events to ~4/sec
        if last_emit.elapsed().as_millis() >= 250 {
            last_emit = Instant::now();
            let _ = app.emit(
                "plugin-import-progress",
                serde_json::json!({
                    "fileName": file_name,
                    "copiedBytes": copied,
                    "totalBytes": total_bytes,
                }),
            );
        }
    }
    dst_file.flush().map_err(err_to_string)?;

    let hash = hasher.finalize().to_hex().to_string();
    Ok((relative_path, hash, copied))
}

#[cfg(unix)]
fn mark_executable(app: &AppHandle, relative_path: &str) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(err_to_string)?;
    let path = app_data_dir.join(relative_path);
    let meta = fs::metadata(&path).map_err(err_to_string)?;
    let mut perms = meta.permissions();
    perms.set_mode(perms.mode() | 0o755);
    fs::set_permissions(&path, perms).map_err(err_to_string)
}

#[cfg(not(unix))]
fn mark_executable(_app: &AppHandle, _relative_path: &str) -> Result<(), String> {
    Ok(())
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

fn onnx_lm_candidate_names(stem: &str) -> Vec<String> {
    vec![
        "lm_6.kenlm".to_string(),
        format!("{stem}.kenlm"),
        format!("{stem}_lm.kenlm"),
    ]
}

fn find_onnx_lm_path(source: &Path) -> Option<PathBuf> {
    let stem = source.file_stem().and_then(|value| value.to_str())?;
    let parent = source.parent()?;
    onnx_lm_candidate_names(stem)
        .into_iter()
        .map(|name| parent.join(name))
        .find(|candidate| candidate.exists() && candidate.is_file())
}

fn find_onnx_kenlm_js_path(source: &Path) -> Option<PathBuf> {
    let parent = source.parent()?;
    let candidate = parent.join("kenlm.js");
    if candidate.exists() && candidate.is_file() {
        return Some(candidate);
    }
    None
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

fn load_asr_ort_package(
    source: &Path,
) -> Result<
    (
        Option<String>,
        PathBuf,
        PathBuf,
        Option<PathBuf>,
        Option<PathBuf>,
    ),
    String,
> {
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
    let lm_path = package
        .lm_path
        .as_ref()
        .map(|value| resolve_package_asset_path(source, value))
        .transpose()?;
    let kenlm_path = package
        .kenlm_wasm_path
        .as_ref()
        .map(|value| resolve_package_asset_path(source, value))
        .transpose()?;
    let kenlm_js_path = match kenlm_path {
        Some(path) => {
            let ext = path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase())
                .ok_or_else(|| {
                    "Package kenlmWasmPath must reference kenlm.js or kenlm.wasm".to_string()
                })?;
            if ext == "js" {
                Some(path)
            } else if ext == "wasm" {
                let js_path = path.with_extension("js");
                if !js_path.exists() || !js_path.is_file() {
                    return Err(format!(
                        "Package kenlmWasmPath references {} but {} is missing",
                        path.display(),
                        js_path.display()
                    ));
                }
                Some(js_path)
            } else {
                return Err(
                    "Package kenlmWasmPath must reference kenlm.js or kenlm.wasm".to_string(),
                );
            }
        }
        None => None,
    };

    Ok((
        package.name.filter(|value| !value.trim().is_empty()),
        model_path,
        vocab_path,
        lm_path,
        kenlm_js_path,
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
    let mut lm_source: Option<PathBuf> = None;
    let mut kenlm_js_source: Option<PathBuf> = None;
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
        lm_source = find_onnx_lm_path(&source);
        kenlm_js_source = find_onnx_kenlm_js_path(&source);
    } else if extension == "asrpkg" {
        let (package_name, model_path, package_vocab_path, package_lm_path, package_kenlm_path) =
            load_asr_ort_package(&source)?;
        entrypoint_source = model_path;
        vocab_source = Some(package_vocab_path);
        lm_source = package_lm_path;
        kenlm_js_source = package_kenlm_path;
        if let Some(name) = package_name {
            display_name_fallback = name;
        } else if let Some(stem) = entrypoint_source
            .file_stem()
            .and_then(|value| value.to_str())
        {
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

    if kind == PluginKind::Llm {
        mark_executable(app, &relative_entrypoint)?;
    }

    if kind == PluginKind::Asr {
        let vocab = vocab_source
            .as_ref()
            .ok_or_else(|| "ASR import requires a vocab file".to_string())?;
        let (relative_vocab_path, vocab_hash, _) = copy_imported_asset(app, &plugin_id, vocab)?;
        let mut asr_metadata = json!({
            "vocabPath": relative_vocab_path,
            "vocabSha256": vocab_hash
        });

        if let Some(lm) = lm_source.as_ref() {
            let (relative_lm_path, lm_hash, _) = copy_imported_asset(app, &plugin_id, lm)?;
            if let Value::Object(fields) = &mut asr_metadata {
                fields.insert("lmPath".to_string(), Value::String(relative_lm_path));
                fields.insert("lmSha256".to_string(), Value::String(lm_hash));
            }
        }

        if let Some(kenlm_js) = kenlm_js_source.as_ref() {
            let (relative_kenlm_path, kenlm_hash, _) =
                copy_imported_asset(app, &plugin_id, kenlm_js)?;
            if let Value::Object(fields) = &mut asr_metadata {
                fields.insert(
                    "kenlmWasmPath".to_string(),
                    Value::String(relative_kenlm_path),
                );
                fields.insert("kenlmWasmSha256".to_string(), Value::String(kenlm_hash));
            }

            let kenlm_wasm = kenlm_js.with_extension("wasm");
            if kenlm_wasm.exists() && kenlm_wasm.is_file() {
                let _ = copy_imported_asset(app, &plugin_id, &kenlm_wasm)?;
            }
        }

        metadata = Some(asr_metadata);
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
