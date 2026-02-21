use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use zip::ZipArchive;

use super::{
    err_to_string,
    manifest_utils::{is_supported_runtime, is_valid_semver},
    PluginImportRequest, PluginKind, PluginManifest,
};

const PACKAGE_SCHEMA_V1: &str = "dr-toru.package.v1";
const PACKAGE_MANIFEST_FILE: &str = "dr_toru_package.json";
const MAX_ZIP_ENTRY_BYTES: u64 = 5_u64 * 1024 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES: u64 = 12_u64 * 1024 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZipImportManifest {
    schema: String,
    kind: PluginKind,
    runtime: String,
    name: Option<String>,
    version: Option<String>,
    model_family: Option<String>,
    license: Option<String>,
    entrypoint: String,
    #[serde(default)]
    assets: Map<String, Value>,
    runtime_config: Option<Value>,
}

#[derive(Debug, Clone)]
struct InstallAsset {
    source_path: PathBuf,
    relative_path: PathBuf,
}

#[derive(Debug, Clone)]
struct AssetBinding {
    key: String,
    asset: InstallAsset,
}

#[derive(Debug)]
struct ParsedZipPackage {
    kind: PluginKind,
    runtime: String,
    name: String,
    version: String,
    model_family: Option<String>,
    license: Option<String>,
    entrypoint: InstallAsset,
    assets: Vec<AssetBinding>,
    supplemental_assets: Vec<InstallAsset>,
    runtime_config: Option<Value>,
}

#[derive(Debug, Clone)]
struct CopiedAsset {
    relative_path: String,
    hash: String,
    size_bytes: u64,
}

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if self.path.exists() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

struct CleanupDirGuard {
    path: PathBuf,
    committed: bool,
}

impl CleanupDirGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for CleanupDirGuard {
    fn drop(&mut self) {
        if !self.committed && self.path.exists() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
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

fn normalize_relative_path(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => continue,
            Component::Normal(part) => normalized.push(part),
            _ => {
                return Err(format!(
                    "Path must be relative and cannot escape package: {}",
                    path.display()
                ));
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("Path cannot be empty".to_string());
    }

    Ok(normalized)
}

fn normalize_relative_path_str(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    normalize_relative_path(Path::new(trimmed))
}

fn relative_path_to_string(path: &Path) -> Result<String, String> {
    let normalized = normalize_relative_path(path)?;
    let mut parts = Vec::new();
    for component in normalized.components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_str().ok_or_else(|| {
                    format!("Path contains non-UTF8 segment: {}", normalized.display())
                })?;
                parts.push(text.to_string());
            }
            _ => {
                return Err(format!(
                    "Path contains invalid component: {}",
                    normalized.display()
                ));
            }
        }
    }

    if parts.is_empty() {
        return Err("Path cannot be empty".to_string());
    }

    Ok(parts.join("/"))
}

fn asset_hash_field_name(key: &str) -> String {
    if let Some(prefix) = key.strip_suffix("Path") {
        return format!("{prefix}Hash");
    }
    format!("{key}Hash")
}

/// Copy a file while computing its hash in a single pass.
/// Emits "plugin-import-progress" events so the frontend can show progress.
fn copy_imported_asset(
    app: &AppHandle,
    plugin_id: &str,
    source: &Path,
    relative_asset_path: &Path,
) -> Result<(String, String, u64), String> {
    let relative_asset = normalize_relative_path(relative_asset_path)?;
    let relative_asset_text = relative_path_to_string(&relative_asset)?;

    let app_data_dir = app.path().app_data_dir().map_err(err_to_string)?;
    let destination = app_data_dir
        .join("plugins")
        .join("assets")
        .join(plugin_id)
        .join(&relative_asset);
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

        // Throttle events to around 4/sec.
        if last_emit.elapsed().as_millis() >= 250 {
            last_emit = Instant::now();
            let _ = app.emit(
                "plugin-import-progress",
                serde_json::json!({
                    "fileName": relative_asset_text,
                    "copiedBytes": copied,
                    "totalBytes": total_bytes,
                }),
            );
        }
    }

    dst_file.flush().map_err(err_to_string)?;

    let hash = hasher.finalize().to_hex().to_string();
    let relative_path = format!("plugins/assets/{plugin_id}/{relative_asset_text}");
    Ok((relative_path, hash, copied))
}

#[cfg(unix)]
fn mark_executable(app: &AppHandle, relative_path: &str) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(err_to_string)?;
    let path = app_data_dir.join(relative_path);
    let meta = fs::metadata(&path).map_err(err_to_string)?;
    let mut perms = meta.permissions();
    // Imported binaries only need the owner execute bit added.
    perms.set_mode(perms.mode() | 0o100);
    fs::set_permissions(&path, perms).map_err(err_to_string)
}

#[cfg(not(unix))]
fn mark_executable(_app: &AppHandle, _relative_path: &str) -> Result<(), String> {
    Ok(())
}

fn copy_stream_with_limit(
    input: &mut impl Read,
    output: &mut impl Write,
    max_bytes: u64,
    context: &str,
) -> Result<u64, String> {
    let mut buffer = [0_u8; 256 * 1024];
    let mut copied: u64 = 0;

    loop {
        let n = input.read(&mut buffer).map_err(err_to_string)?;
        if n == 0 {
            break;
        }

        copied = copied
            .checked_add(n as u64)
            .ok_or_else(|| format!("{context} exceeds maximum size"))?;
        if copied > max_bytes {
            return Err(format!(
                "{context} exceeds maximum size of {max_bytes} bytes"
            ));
        }

        output.write_all(&buffer[..n]).map_err(err_to_string)?;
    }

    Ok(copied)
}

fn extract_zip_to_temp(source: &Path) -> Result<PathBuf, String> {
    extract_zip_to_temp_with_limits(source, MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES)
}

fn extract_zip_to_temp_with_limits(
    source: &Path,
    max_entry_bytes: u64,
    max_total_bytes: u64,
) -> Result<PathBuf, String> {
    let extract_root = std::env::temp_dir().join(format!("dr-toru-plugin-import-{}", now_suffix()));
    fs::create_dir_all(&extract_root).map_err(err_to_string)?;

    let result = (|| {
        let file = File::open(source).map_err(err_to_string)?;
        let mut archive = ZipArchive::new(file).map_err(err_to_string)?;
        if archive.len() == 0 {
            return Err("Zip package is empty".to_string());
        }
        let mut total_copied: u64 = 0;

        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(err_to_string)?;
            let entry_name = entry.name().to_string();
            if entry.size() > max_entry_bytes {
                return Err(format!(
                    "Zip entry {entry_name} exceeds maximum size of {max_entry_bytes} bytes"
                ));
            }
            let projected_size = total_copied
                .checked_add(entry.size())
                .ok_or_else(|| "Zip package exceeds maximum total size".to_string())?;
            if projected_size > max_total_bytes {
                return Err(format!(
                    "Zip package exceeds maximum total size of {max_total_bytes} bytes"
                ));
            }

            if let Some(mode) = entry.unix_mode() {
                if mode & 0o170000 == 0o120000 {
                    return Err(format!("Zip package cannot contain symlinks: {entry_name}"));
                }
            }

            let Some(enclosed) = entry.enclosed_name().map(|value| value.to_path_buf()) else {
                return Err(format!("Zip entry has invalid path: {entry_name}"));
            };
            let normalized = normalize_relative_path(&enclosed)?;
            let output_path = extract_root.join(&normalized);

            if entry.is_dir() {
                fs::create_dir_all(&output_path).map_err(err_to_string)?;
                continue;
            }

            let Some(parent) = output_path.parent() else {
                return Err(format!("Invalid zip entry path: {entry_name}"));
            };
            fs::create_dir_all(parent).map_err(err_to_string)?;

            let mut output_file = File::create(&output_path).map_err(err_to_string)?;
            let copied = copy_stream_with_limit(
                &mut entry,
                &mut output_file,
                max_entry_bytes,
                &format!("Zip entry {entry_name}"),
            )?;
            total_copied = total_copied
                .checked_add(copied)
                .ok_or_else(|| "Zip package exceeds maximum total size".to_string())?;
            if total_copied > max_total_bytes {
                return Err(format!(
                    "Zip package exceeds maximum total size of {max_total_bytes} bytes"
                ));
            }
            output_file.flush().map_err(err_to_string)?;
        }

        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&extract_root);
    }

    result.map(|_| extract_root)
}

fn resolve_extracted_asset_path(root: &Path, value: &str) -> Result<InstallAsset, String> {
    let relative_path = normalize_relative_path_str(value)?;
    let source_path = root.join(&relative_path);
    if !source_path.exists() || !source_path.is_file() {
        return Err(format!(
            "Package asset not found: {}",
            source_path.display()
        ));
    }

    Ok(InstallAsset {
        source_path,
        relative_path,
    })
}

fn insert_default_llm_metadata(fields: &mut Map<String, Value>) {
    fields.insert(
        "serviceStartArgs".to_string(),
        json!(["--server", "--port", "{port}", "--nobrowser"]),
    );
    fields.insert(
        "serviceHealthPath".to_string(),
        Value::String("/health".to_string()),
    );
    fields.insert(
        "serviceCompletionPath".to_string(),
        Value::String("/completion".to_string()),
    );
}

fn default_asr_runtime_config(runtime: &str) -> Value {
    let asr_type = if runtime == "ort-whisper" {
        "whisper"
    } else {
        "ctc"
    };
    json!({ "asrType": asr_type })
}

fn load_zip_package(extract_root: &Path) -> Result<ParsedZipPackage, String> {
    let manifest_path = extract_root.join(PACKAGE_MANIFEST_FILE);
    if !manifest_path.exists() || !manifest_path.is_file() {
        return Err(format!(
            "Zip package must include {} at the archive root",
            PACKAGE_MANIFEST_FILE
        ));
    }

    let raw = fs::read_to_string(&manifest_path).map_err(err_to_string)?;
    let package: ZipImportManifest = serde_json::from_str(&raw).map_err(err_to_string)?;
    let ZipImportManifest {
        schema,
        kind,
        runtime,
        name,
        version,
        model_family,
        license,
        entrypoint,
        assets: raw_assets,
        runtime_config,
    } = package;

    if schema != PACKAGE_SCHEMA_V1 {
        return Err(format!(
            "Unsupported package schema: {} (expected {})",
            schema, PACKAGE_SCHEMA_V1
        ));
    }

    let runtime = runtime.trim().to_string();
    if runtime.is_empty() {
        return Err("Package runtime is required".to_string());
    }
    if !is_supported_runtime(&kind, &runtime) {
        return Err(format!(
            "Unsupported runtime {} for kind {:?}",
            runtime, kind
        ));
    }

    let name = name
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Package name is required".to_string())?;

    let version = version
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Package version is required".to_string())?;
    if !is_valid_semver(&version) {
        return Err("Package version must follow semver x.y.z".to_string());
    }

    let entrypoint = resolve_extracted_asset_path(extract_root, &entrypoint)?;

    let mut assets = Vec::new();
    let mut seen_keys = HashSet::new();
    let mut hash_key_to_source = HashMap::<String, String>::new();
    for (key, value) in raw_assets {
        let trimmed_key = key.trim().to_string();
        if trimmed_key.is_empty() {
            return Err("Package assets keys cannot be empty".to_string());
        }
        if !seen_keys.insert(trimmed_key.clone()) {
            return Err(format!("Duplicate package asset key: {trimmed_key}"));
        }

        let hash_key = asset_hash_field_name(&trimmed_key);
        if let Some(previous_key) = hash_key_to_source.insert(hash_key.clone(), trimmed_key.clone())
        {
            return Err(format!(
                "Package assets keys {previous_key} and {trimmed_key} map to the same hash field {hash_key}"
            ));
        }

        let Value::String(path_value) = value else {
            return Err(format!("Package asset {} must be a string path", key));
        };

        let asset = resolve_extracted_asset_path(extract_root, &path_value)?;
        assets.push(AssetBinding {
            key: trimmed_key,
            asset,
        });
    }

    let mut supplemental_assets = Vec::new();
    if kind == PluginKind::Asr && runtime == "ort-ctc" {
        if !assets.iter().any(|asset| asset.key == "vocabPath") {
            return Err("ASR runtime ort-ctc requires assets.vocabPath".to_string());
        }

        if let Some(kenlm_binding) = assets.iter_mut().find(|asset| asset.key == "kenlmWasmPath") {
            let ext = kenlm_binding
                .asset
                .relative_path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase())
                .ok_or_else(|| {
                    "assets.kenlmWasmPath must reference kenlm.js or kenlm.wasm".to_string()
                })?;

            if ext == "wasm" {
                let js_relative = kenlm_binding.asset.relative_path.with_extension("js");
                let js_source = extract_root.join(&js_relative);
                if !js_source.exists() || !js_source.is_file() {
                    return Err(format!(
                        "assets.kenlmWasmPath references {} but {} is missing",
                        kenlm_binding.asset.relative_path.display(),
                        js_relative.display()
                    ));
                }
                // The ASR worker expects kenlmWasmPath to point at the JS loader.
                // If a package points this field at .wasm, normalize it here and
                // install the .wasm as a supplemental sidecar.
                kenlm_binding.asset = InstallAsset {
                    source_path: js_source,
                    relative_path: js_relative,
                };
            } else if ext != "js" {
                return Err(
                    "assets.kenlmWasmPath must reference kenlm.js or kenlm.wasm".to_string()
                );
            }

            let wasm_relative = kenlm_binding.asset.relative_path.with_extension("wasm");
            let wasm_source = extract_root.join(&wasm_relative);
            if wasm_source.exists() && wasm_source.is_file() {
                supplemental_assets.push(InstallAsset {
                    source_path: wasm_source,
                    relative_path: wasm_relative,
                });
            }
        }
    }

    Ok(ParsedZipPackage {
        kind,
        runtime,
        name,
        version,
        model_family,
        license,
        entrypoint,
        assets,
        supplemental_assets,
        runtime_config,
    })
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

    let kind;
    let runtime;
    let prefix;
    let display_name_fallback;
    let mut version = "1.0.0".to_string();
    let mut model_family = None;
    let mut license = None;
    let mut metadata_fields = Map::<String, Value>::new();
    let entrypoint_asset;
    let mut bound_assets: Vec<AssetBinding> = Vec::new();
    let mut supplemental_assets: Vec<InstallAsset> = Vec::new();
    let mut _extract_guard: Option<TempDirGuard> = None;

    if extension == "llamafile" {
        kind = PluginKind::Llm;
        runtime = "llamafile".to_string();
        prefix = "import.llm";
        display_name_fallback = source_stem.clone();

        insert_default_llm_metadata(&mut metadata_fields);

        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("Invalid source file name: {}", source.display()))?
            .to_string();

        entrypoint_asset = InstallAsset {
            source_path: source.clone(),
            relative_path: PathBuf::from(file_name),
        };
    } else if extension == "zip" {
        let extract_root = extract_zip_to_temp(&source)?;
        _extract_guard = Some(TempDirGuard::new(extract_root.clone()));

        let package = load_zip_package(&extract_root)?;
        kind = package.kind;
        runtime = package.runtime;
        prefix = if kind == PluginKind::Asr {
            "import.asr"
        } else {
            "import.llm"
        };
        display_name_fallback = package.name;
        version = package.version;
        model_family = package.model_family;
        license = package.license;
        entrypoint_asset = package.entrypoint;
        bound_assets = package.assets;
        supplemental_assets = package.supplemental_assets;

        if let Some(runtime_config) = package.runtime_config {
            metadata_fields.insert("runtimeConfig".to_string(), runtime_config);
        }

        if kind == PluginKind::Llm {
            insert_default_llm_metadata(&mut metadata_fields);
        }
    } else {
        return Err("Only .llamafile and .zip imports are supported".to_string());
    }

    let slug = sanitize_slug(&source_stem);
    let slug = if slug.is_empty() {
        "model".to_string()
    } else {
        slug
    };
    let plugin_id = format!("{prefix}.{}.{}", slug, now_suffix());
    let app_data_dir = app.path().app_data_dir().map_err(err_to_string)?;
    let destination_dir = app_data_dir.join("plugins").join("assets").join(&plugin_id);
    if destination_dir.exists() {
        return Err(format!(
            "Import destination already exists: {}",
            destination_dir.display()
        ));
    }
    let mut destination_guard = CleanupDirGuard::new(destination_dir);

    let mut copied_assets: HashMap<String, CopiedAsset> = HashMap::new();
    let mut total_size_bytes: u64 = 0;
    let mut copy_asset_once = |asset: &InstallAsset| -> Result<CopiedAsset, String> {
        let key = relative_path_to_string(&asset.relative_path)?;
        if let Some(existing) = copied_assets.get(&key) {
            return Ok(existing.clone());
        }

        let (relative_path, hash, size_bytes) =
            copy_imported_asset(app, &plugin_id, &asset.source_path, &asset.relative_path)?;
        let copied = CopiedAsset {
            relative_path,
            hash,
            size_bytes,
        };

        total_size_bytes += copied.size_bytes;
        copied_assets.insert(key, copied.clone());
        Ok(copied)
    };

    let copied_entrypoint = copy_asset_once(&entrypoint_asset)?;
    if kind == PluginKind::Llm {
        mark_executable(app, &copied_entrypoint.relative_path)?;
    }

    if !bound_assets.is_empty() {
        let mut assets_map = Map::new();
        for binding in &bound_assets {
            let copied = copy_asset_once(&binding.asset)?;
            metadata_fields.insert(
                binding.key.clone(),
                Value::String(copied.relative_path.clone()),
            );
            metadata_fields.insert(
                asset_hash_field_name(&binding.key),
                Value::String(copied.hash.clone()),
            );
            assets_map.insert(
                binding.key.clone(),
                Value::String(copied.relative_path.clone()),
            );
        }
        metadata_fields.insert("assets".to_string(), Value::Object(assets_map));
    }

    if !supplemental_assets.is_empty() {
        for asset in &supplemental_assets {
            let _ = copy_asset_once(asset)?;
        }
    }

    if kind == PluginKind::Asr && !metadata_fields.contains_key("runtimeConfig") {
        metadata_fields.insert(
            "runtimeConfig".to_string(),
            default_asr_runtime_config(&runtime),
        );
    }

    let installed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();
    destination_guard.commit();

    Ok(PluginManifest {
        plugin_id,
        name: request
            .display_name
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(display_name_fallback),
        version,
        kind,
        runtime,
        entrypoint_path: copied_entrypoint.relative_path,
        hash: copied_entrypoint.hash,
        model_family,
        size_bytes: Some(total_size_bytes),
        license,
        installed_at: Some(installed_at),
        metadata: if metadata_fields.is_empty() {
            None
        } else {
            Some(Value::Object(metadata_fields))
        },
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

#[cfg(test)]
mod tests {
    use super::{
        extract_zip_to_temp, extract_zip_to_temp_with_limits, load_zip_package, now_suffix,
        PACKAGE_MANIFEST_FILE, PACKAGE_SCHEMA_V1,
    };
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("dr-toru-import-test-{label}-{}", now_suffix()));
            fs::create_dir_all(&path).expect("failed to create temp dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            if self.0.exists() {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn write_file(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent dir");
        }
        let mut file = File::create(path).expect("failed to create file");
        file.write_all(contents).expect("failed to write file");
        file.flush().expect("failed to flush file");
    }

    #[test]
    fn load_zip_package_accepts_valid_ctc_manifest() {
        let dir = TempDir::new("valid");
        write_file(dir.path().join("models/model.onnx").as_path(), b"onnx");
        write_file(
            dir.path().join("models/vocab.json").as_path(),
            br#"{"tokens":[]}"#,
        );
        write_file(dir.path().join("kenlm/kenlm.js").as_path(), b"js");
        write_file(dir.path().join("kenlm/kenlm.wasm").as_path(), b"wasm");

        let manifest = format!(
            r#"{{
  "schema": "{schema}",
  "kind": "asr",
  "runtime": "ort-ctc",
  "name": "Zip ASR",
  "version": "1.2.3",
  "entrypoint": "models/model.onnx",
  "assets": {{
    "vocabPath": "models/vocab.json",
    "kenlmWasmPath": "kenlm/kenlm.js"
  }}
}}"#,
            schema = PACKAGE_SCHEMA_V1
        );
        write_file(
            dir.path().join(PACKAGE_MANIFEST_FILE).as_path(),
            manifest.as_bytes(),
        );

        let parsed = load_zip_package(dir.path()).expect("expected valid package");
        assert_eq!(parsed.runtime, "ort-ctc");
        assert_eq!(parsed.name, "Zip ASR");
        assert_eq!(parsed.version, "1.2.3");
        assert_eq!(parsed.assets.len(), 2);
        assert_eq!(parsed.supplemental_assets.len(), 1);
    }

    #[test]
    fn load_zip_package_rejects_missing_manifest() {
        let dir = TempDir::new("missing-manifest");
        let error = load_zip_package(dir.path()).expect_err("expected missing manifest error");
        assert!(error.contains(PACKAGE_MANIFEST_FILE));
    }

    #[test]
    fn load_zip_package_rejects_missing_referenced_file() {
        let dir = TempDir::new("missing-asset");
        write_file(dir.path().join("models/model.onnx").as_path(), b"onnx");

        let manifest = format!(
            r#"{{
  "schema": "{schema}",
  "kind": "asr",
  "runtime": "ort-ctc",
  "name": "Zip ASR",
  "version": "1.0.0",
  "entrypoint": "models/model.onnx",
  "assets": {{
    "vocabPath": "models/missing_vocab.json"
  }}
}}"#,
            schema = PACKAGE_SCHEMA_V1
        );
        write_file(
            dir.path().join(PACKAGE_MANIFEST_FILE).as_path(),
            manifest.as_bytes(),
        );

        let error = load_zip_package(dir.path()).expect_err("expected missing asset error");
        assert!(error.contains("Package asset not found"));
    }

    #[test]
    fn load_zip_package_rejects_invalid_runtime_for_kind() {
        let dir = TempDir::new("invalid-runtime-kind");
        write_file(dir.path().join("model.bin").as_path(), b"model");

        let manifest = format!(
            r#"{{
  "schema": "{schema}",
  "kind": "llm",
  "runtime": "ort-ctc",
  "name": "Zip LLM",
  "version": "1.0.0",
  "entrypoint": "model.bin"
}}"#,
            schema = PACKAGE_SCHEMA_V1
        );
        write_file(
            dir.path().join(PACKAGE_MANIFEST_FILE).as_path(),
            manifest.as_bytes(),
        );

        let error = load_zip_package(dir.path()).expect_err("expected runtime-kind error");
        assert!(error.contains("Unsupported runtime"));
    }

    #[test]
    fn load_zip_package_rejects_colliding_hash_keys() {
        let dir = TempDir::new("colliding-hash-keys");
        write_file(dir.path().join("a.bin").as_path(), b"a");
        write_file(dir.path().join("b.bin").as_path(), b"b");

        let manifest = format!(
            r#"{{
  "schema": "{schema}",
  "kind": "llm",
  "runtime": "llamafile",
  "name": "Zip LLM",
  "version": "1.0.0",
  "entrypoint": "a.bin",
  "assets": {{
    "model": "a.bin",
    "modelPath": "b.bin"
  }}
}}"#,
            schema = PACKAGE_SCHEMA_V1
        );
        write_file(
            dir.path().join(PACKAGE_MANIFEST_FILE).as_path(),
            manifest.as_bytes(),
        );

        let error = load_zip_package(dir.path()).expect_err("expected hash key collision error");
        assert!(error.contains("same hash field"));
    }

    #[test]
    fn extract_zip_to_temp_rejects_entry_over_limit() {
        let dir = TempDir::new("entry-limit");
        let zip_path = dir.path().join("entry-limit.zip");

        let mut zip = ZipWriter::new(File::create(&zip_path).expect("failed to create zip file"));
        let options = SimpleFileOptions::default();
        zip.start_file("large.bin", options)
            .expect("failed to start zip entry");
        zip.write_all(b"0123456789")
            .expect("failed to write zip entry");
        zip.finish().expect("failed to finish zip");

        let error = extract_zip_to_temp_with_limits(&zip_path, 5, 100)
            .expect_err("expected zip entry limit rejection");
        assert!(error.contains("exceeds maximum size"));
    }

    #[test]
    fn extract_zip_to_temp_rejects_total_size_over_limit() {
        let dir = TempDir::new("total-limit");
        let zip_path = dir.path().join("total-limit.zip");

        let mut zip = ZipWriter::new(File::create(&zip_path).expect("failed to create zip file"));
        let options = SimpleFileOptions::default();
        zip.start_file("first.bin", options)
            .expect("failed to start first zip entry");
        zip.write_all(b"1234")
            .expect("failed to write first zip entry");
        zip.start_file("second.bin", options)
            .expect("failed to start second zip entry");
        zip.write_all(b"5678")
            .expect("failed to write second zip entry");
        zip.finish().expect("failed to finish zip");

        let error = extract_zip_to_temp_with_limits(&zip_path, 100, 7)
            .expect_err("expected total zip size rejection");
        assert!(error.contains("maximum total size"));
    }

    #[test]
    fn extract_zip_to_temp_rejects_path_traversal_entry() {
        let dir = TempDir::new("path-traversal");
        let zip_path = dir.path().join("bad.zip");

        let mut zip = ZipWriter::new(File::create(&zip_path).expect("failed to create zip file"));
        let options = SimpleFileOptions::default();
        zip.start_file("../escape.txt", options)
            .expect("failed to start zip entry");
        zip.write_all(b"bad").expect("failed to write zip entry");
        zip.finish().expect("failed to finish zip");

        let error = extract_zip_to_temp(&zip_path).expect_err("expected path traversal rejection");
        assert!(error.contains("invalid path") || error.contains("cannot escape package"));
    }
}
