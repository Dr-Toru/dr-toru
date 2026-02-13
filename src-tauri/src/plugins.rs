use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const REGISTRY_FORMAT: u8 = 1;
const REGISTRY_FILE_NAME: &str = "registry.json";
const BUILTIN_ORT_ASR_PLUGIN_ID: &str = "builtin.asr.ort.medasr";
const CAP_ASR_STREAM: &str = "asr.stream";
const CAP_LLM_TRANSFORM_CORRECT: &str = "llm.transform.correct";
const CAP_LLM_TRANSFORM_SOAP: &str = "llm.transform.soap";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Asr,
    Llm,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginRuntime {
    Ort,
    Llamafile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderRole {
    Asr,
    Transform,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub plugin_id: String,
    pub name: String,
    pub version: String,
    pub kind: PluginKind,
    pub runtime: PluginRuntime,
    pub entrypoint_path: String,
    pub sha256: String,
    pub capabilities: Vec<String>,
    pub model_family: Option<String>,
    pub size_bytes: Option<u64>,
    pub license: Option<String>,
    pub installed_at: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveProviders {
    pub asr: Option<String>,
    pub transform: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryState {
    pub format: u8,
    pub plugins: Vec<PluginManifest>,
    pub active_providers: ActiveProviders,
}

impl Default for PluginRegistryState {
    fn default() -> Self {
        Self {
            format: REGISTRY_FORMAT,
            plugins: vec![builtin_ort_asr_plugin()],
            active_providers: ActiveProviders {
                asr: Some(BUILTIN_ORT_ASR_PLUGIN_ID.to_string()),
                transform: None,
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiscoveryRequest {
    pub role: Option<ProviderRole>,
    pub required_capabilities: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    pub ready: bool,
    pub message: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeExecuteResult {
    pub text: String,
}

#[derive(Default)]
pub struct PluginRuntimeState {
    running_llamafile: Mutex<HashMap<String, RunningLlamafile>>,
}

impl PluginRuntimeState {
    fn lock_running(&self) -> MutexGuard<'_, HashMap<String, RunningLlamafile>> {
        self.running_llamafile.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct RunningLlamafile {
    child: std::process::Child,
    endpoint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginImportRequest {
    pub source_path: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone)]
struct PluginPaths {
    registry_file: PathBuf,
}

fn err_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn plugin_paths(app: &AppHandle) -> Result<PluginPaths, String> {
    let root = app.path().app_data_dir().map_err(err_to_string)?;
    Ok(PluginPaths {
        registry_file: root.join("plugins").join(REGISTRY_FILE_NAME),
    })
}

fn ensure_registry(paths: &PluginPaths) -> Result<(), String> {
    let Some(parent) = paths.registry_file.parent() else {
        return Err("Missing plugin registry directory".to_string());
    };
    fs::create_dir_all(parent).map_err(err_to_string)?;

    if !paths.registry_file.exists() {
        write_json_atomic(&paths.registry_file, &PluginRegistryState::default()).map_err(err_to_string)?;
    }

    Ok(())
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos}-{}", std::process::id())
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let Some(parent) = path.parent() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Path has no parent directory",
        ));
    };
    fs::create_dir_all(parent)?;

    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Path has no valid file name",
        ));
    };

    let tmp_path = parent.join(format!(".{file_name}.tmp-{}", unique_suffix()));
    {
        let mut file = File::create(&tmp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }

    if let Err(rename_error) = fs::rename(&tmp_path, path) {
        if path.exists() {
            fs::remove_file(path)?;
            fs::rename(&tmp_path, path)?;
            return Ok(());
        }

        let _ = fs::remove_file(&tmp_path);
        return Err(rename_error);
    }

    Ok(())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let encoded = serde_json::to_vec_pretty(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_bytes_atomic(path, &encoded)
}

fn load_registry(paths: &PluginPaths) -> Result<PluginRegistryState, String> {
    let raw = fs::read_to_string(&paths.registry_file).map_err(err_to_string)?;
    let state = serde_json::from_str::<PluginRegistryState>(&raw).map_err(err_to_string)?;
    let sanitized = sanitize_registry(state)?;
    Ok(sanitized)
}

fn save_registry(paths: &PluginPaths, state: &PluginRegistryState) -> Result<(), String> {
    write_json_atomic(&paths.registry_file, state).map_err(err_to_string)
}

fn builtin_ort_asr_plugin() -> PluginManifest {
    PluginManifest {
        plugin_id: BUILTIN_ORT_ASR_PLUGIN_ID.to_string(),
        name: "Built-in Medical ASR".to_string(),
        version: "1.0.0".to_string(),
        kind: PluginKind::Asr,
        runtime: PluginRuntime::Ort,
        entrypoint_path: "models/medasr_lasr_ctc.onnx".to_string(),
        sha256: "f1d2ea1680bfa2a8adc76b80403b1edce20a6f1681bde1a20cc42ab59136d971".to_string(),
        capabilities: vec![CAP_ASR_STREAM.to_string()],
        model_family: Some("medasr_lasr".to_string()),
        size_bytes: None,
        license: None,
        installed_at: None,
        metadata: Some(Value::Object(Map::from_iter([
            (
                "vocabPath".to_string(),
                Value::String("models/medasr_lasr_vocab.json".to_string()),
            ),
            (
                "vocabSha256".to_string(),
                Value::String(
                    "631bd152b5beca9a74d21bd1c3ff53fecf63d10d11aae72e491cacdfbf69a756".to_string(),
                ),
            ),
        ]))),
    }
}

fn is_valid_plugin_id(value: &str) -> bool {
    let length = value.len();
    if !(3..=128).contains(&length) {
        return false;
    }
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-')
}

fn is_valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_valid_semver(value: &str) -> bool {
    let (core, _) = value.split_once('-').unwrap_or((value, ""));
    let mut parts = core.split('.');
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    let Some(patch) = parts.next() else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    !major.is_empty()
        && !minor.is_empty()
        && !patch.is_empty()
        && major.bytes().all(|byte| byte.is_ascii_digit())
        && minor.bytes().all(|byte| byte.is_ascii_digit())
        && patch.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_known_capability(capability: &str) -> bool {
    matches!(
        capability,
        CAP_ASR_STREAM | CAP_LLM_TRANSFORM_CORRECT | CAP_LLM_TRANSFORM_SOAP
    )
}

fn supports_role(manifest: &PluginManifest, role: ProviderRole) -> bool {
    match role {
        ProviderRole::Asr => {
            manifest.kind == PluginKind::Asr
                && manifest.capabilities.iter().any(|item| item == CAP_ASR_STREAM)
        }
        ProviderRole::Transform => {
            manifest.kind == PluginKind::Llm
                && manifest
                    .capabilities
                    .iter()
                    .any(|item| item == CAP_LLM_TRANSFORM_CORRECT || item == CAP_LLM_TRANSFORM_SOAP)
        }
    }
}

fn validate_manifest(manifest: &PluginManifest) -> Result<(), String> {
    if !is_valid_plugin_id(&manifest.plugin_id) {
        return Err("pluginId must be 3-128 chars and use [A-Za-z0-9._-]".to_string());
    }
    if manifest.name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    if !is_valid_semver(&manifest.version) {
        return Err("version must follow semver x.y.z".to_string());
    }
    if manifest.entrypoint_path.trim().is_empty() {
        return Err("entrypointPath is required".to_string());
    }
    if !is_valid_sha256(&manifest.sha256) {
        return Err("sha256 must be 64 lowercase hex chars".to_string());
    }
    if manifest.capabilities.is_empty() {
        return Err("at least one capability is required".to_string());
    }

    let mut seen = HashSet::new();
    for capability in &manifest.capabilities {
        if !is_known_capability(capability) {
            return Err(format!("unsupported capability: {capability}"));
        }
        if !seen.insert(capability) {
            return Err(format!("duplicate capability: {capability}"));
        }
    }

    match manifest.kind {
        PluginKind::Asr => {
            if manifest.runtime != PluginRuntime::Ort {
                return Err("asr plugins must use ort runtime in v1".to_string());
            }
            if !manifest.capabilities.iter().any(|item| item == CAP_ASR_STREAM) {
                return Err("asr plugins must include asr.stream".to_string());
            }
        }
        PluginKind::Llm => {
            if manifest.runtime != PluginRuntime::Llamafile {
                return Err("llm plugins must use llamafile runtime in v1".to_string());
            }
            if !manifest
                .capabilities
                .iter()
                .any(|item| item == CAP_LLM_TRANSFORM_CORRECT || item == CAP_LLM_TRANSFORM_SOAP)
            {
                return Err("llm plugins must include a transform capability".to_string());
            }
        }
    }

    Ok(())
}

fn sanitize_registry(mut state: PluginRegistryState) -> Result<PluginRegistryState, String> {
    if state.format != REGISTRY_FORMAT {
        return Err(format!(
            "Unsupported plugin registry format {}, expected {}",
            state.format, REGISTRY_FORMAT
        ));
    }

    let mut valid_plugins: Vec<PluginManifest> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    for plugin in state.plugins.drain(..) {
        if validate_manifest(&plugin).is_err() {
            continue;
        }
        if !seen_ids.insert(plugin.plugin_id.clone()) {
            continue;
        }
        valid_plugins.push(plugin);
    }

    if !valid_plugins
        .iter()
        .any(|plugin| plugin.plugin_id == BUILTIN_ORT_ASR_PLUGIN_ID)
    {
        valid_plugins.push(builtin_ort_asr_plugin());
    }

    let has_asr_active = state
        .active_providers
        .asr
        .as_ref()
        .map(|plugin_id| {
            valid_plugins
                .iter()
                .any(|plugin| plugin.plugin_id == *plugin_id && supports_role(plugin, ProviderRole::Asr))
        })
        .unwrap_or(false);
    if !has_asr_active {
        state.active_providers.asr = Some(BUILTIN_ORT_ASR_PLUGIN_ID.to_string());
    }

    let has_transform_active = state
        .active_providers
        .transform
        .as_ref()
        .map(|plugin_id| {
            valid_plugins.iter().any(|plugin| {
                plugin.plugin_id == *plugin_id && supports_role(plugin, ProviderRole::Transform)
            })
        })
        .unwrap_or(false);
    if !has_transform_active {
        state.active_providers.transform = None;
    }

    Ok(PluginRegistryState {
        format: REGISTRY_FORMAT,
        plugins: valid_plugins,
        active_providers: state.active_providers,
    })
}

fn resolve_plugin<'a>(state: &'a PluginRegistryState, plugin_id: &str) -> Option<&'a PluginManifest> {
    state.plugins.iter().find(|plugin| plugin.plugin_id == plugin_id)
}

fn resolve_entrypoint(app: &AppHandle, entrypoint_path: &str) -> Result<PathBuf, String> {
    if entrypoint_path.trim().is_empty() {
        return Err("entrypointPath cannot be empty".to_string());
    }
    let candidate = PathBuf::from(entrypoint_path);
    if candidate.is_absolute() {
        return Ok(candidate);
    }
    if entrypoint_path.contains("..") {
        return Err("entrypointPath cannot contain path traversal".to_string());
    }
    let app_data = app.path().app_data_dir().map_err(err_to_string)?;
    Ok(app_data.join(candidate))
}

fn default_llamafile_prompt(capability: &str) -> String {
    if capability == CAP_LLM_TRANSFORM_SOAP {
        return "Convert the note into SOAP format.".to_string();
    }
    "Correct grammar and punctuation while preserving clinical meaning.".to_string()
}

fn parse_string_array_field(metadata: &Option<Value>, field: &str) -> Option<Vec<String>> {
    let Some(Value::Object(map)) = metadata else {
        return None;
    };
    let Some(Value::Array(values)) = map.get(field) else {
        return None;
    };

    let mut args = Vec::new();
    for value in values {
        let Value::String(text) = value else {
            return None;
        };
        args.push(text.clone());
    }
    Some(args)
}

fn parse_string_field(metadata: &Option<Value>, field: &str) -> Option<String> {
    let Some(Value::Object(map)) = metadata else {
        return None;
    };
    let Some(Value::String(value)) = map.get(field) else {
        return None;
    };
    Some(value.clone())
}

fn normalize_http_path(path: &str, default_path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return default_path.to_string();
    }
    if trimmed.starts_with('/') {
        return trimmed.to_string();
    }
    format!("/{trimmed}")
}

fn service_health_path(metadata: &Option<Value>) -> String {
    let configured = parse_string_field(metadata, "serviceHealthPath")
        .unwrap_or_else(|| "/health".to_string());
    normalize_http_path(&configured, "/health")
}

fn service_completion_path(metadata: &Option<Value>) -> String {
    let configured = parse_string_field(metadata, "serviceCompletionPath")
        .unwrap_or_else(|| "/completion".to_string());
    normalize_http_path(&configured, "/completion")
}

fn build_url(endpoint: &str, path: &str) -> String {
    let normalized = normalize_http_path(path, "/");
    format!("{endpoint}{normalized}")
}

fn service_start_args(metadata: &Option<Value>, port: u16) -> Vec<String> {
    let templates = parse_string_array_field(metadata, "serviceStartArgs")
        .unwrap_or_else(|| {
            vec![
                "--server".to_string(),
                "--port".to_string(),
                "{port}".to_string(),
                "--nobrowser".to_string(),
            ]
        });
    templates
        .into_iter()
        .map(|template| template.replace("{port}", &port.to_string()))
        .collect()
}

fn extract_completion_text(payload: &Value) -> Option<String> {
    if let Some(text) = payload.get("content").and_then(Value::as_str) {
        return Some(text.to_string());
    }

    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| {
            choice
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    choice
                        .get("message")
                        .and_then(Value::as_object)
                        .and_then(|message| message.get("content"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
        })
}

fn pick_open_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(err_to_string)?;
    let port = listener.local_addr().map_err(err_to_string)?.port();
    Ok(port)
}

fn http_agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(timeout)
        .timeout_read(timeout)
        .timeout_write(timeout)
        .build()
}

fn http_get(endpoint: &str, path: &str, timeout: Duration) -> Result<(u16, String), String> {
    let url = build_url(endpoint, path);
    let response = http_agent(timeout).get(&url).call();
    match response {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.into_string().map_err(err_to_string)?;
            Ok((status, body))
        }
        Err(ureq::Error::Status(status, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Ok((status, body))
        }
        Err(error) => Err(err_to_string(error)),
    }
}

fn http_post_json(
    endpoint: &str,
    path: &str,
    body: &Value,
    timeout: Duration,
) -> Result<(u16, String), String> {
    let url = build_url(endpoint, path);
    let response = http_agent(timeout).post(&url).send_json(body.clone());
    match response {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.into_string().map_err(err_to_string)?;
            Ok((status, body))
        }
        Err(ureq::Error::Status(status, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Ok((status, body))
        }
        Err(error) => Err(err_to_string(error)),
    }
}

fn wait_for_service_ready(endpoint: &str, health_path: &str) -> Result<(), String> {
    let timeout = Duration::from_millis(700);
    for _ in 0..20 {
        if let Ok((status, _)) = http_get(endpoint, health_path, timeout) {
            if status < 500 {
                return Ok(());
            }
        }
        sleep(Duration::from_millis(200));
    }
    Err(format!(
        "Llamafile service did not become ready at {endpoint}{health_path}"
    ))
}

fn stop_service(
    running: &mut HashMap<String, RunningLlamafile>,
    plugin_id: &str,
) -> Result<(), String> {
    let Some(mut service) = running.remove(plugin_id) else {
        return Ok(());
    };
    let _ = service.child.kill();
    service.child.wait().map_err(err_to_string)?;
    Ok(())
}

fn cleanup_service_if_exited(
    running: &mut HashMap<String, RunningLlamafile>,
    plugin_id: &str,
) -> Result<Option<i32>, String> {
    let Some(service) = running.get_mut(plugin_id) else {
        return Ok(None);
    };

    let exited = service.child.try_wait().map_err(err_to_string)?;
    if let Some(status) = exited {
        let code = status.code().unwrap_or(-1);
        running.remove(plugin_id);
        return Ok(Some(code));
    }
    Ok(None)
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

fn imported_plugin_manifest(
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

    let (kind, runtime, capabilities, prefix) = if extension == "llamafile" {
        (
            PluginKind::Llm,
            PluginRuntime::Llamafile,
            vec![
                CAP_LLM_TRANSFORM_CORRECT.to_string(),
                CAP_LLM_TRANSFORM_SOAP.to_string(),
            ],
            "import.llm",
        )
    } else if extension == "onnx" {
        (
            PluginKind::Asr,
            PluginRuntime::Ort,
            vec![CAP_ASR_STREAM.to_string()],
            "import.asr",
        )
    } else {
        return Err("Only .llamafile and .onnx imports are supported".to_string());
    };

    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("model");
    let slug = sanitize_slug(stem);
    let slug = if slug.is_empty() {
        "model".to_string()
    } else {
        slug
    };
    let plugin_id = format!("{prefix}.{}.{}", slug, now_suffix());
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid source file name".to_string())?;

    let relative_entrypoint = format!("plugins/assets/{plugin_id}/{file_name}");
    let app_data_dir = app.path().app_data_dir().map_err(err_to_string)?;
    let destination = app_data_dir.join(&relative_entrypoint);
    let Some(parent) = destination.parent() else {
        return Err("Invalid destination path".to_string());
    };
    fs::create_dir_all(parent).map_err(err_to_string)?;
    fs::copy(&source, &destination).map_err(err_to_string)?;

    let file_hash = file_sha256(&destination)?;
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
            .unwrap_or_else(|| stem.to_string()),
        version: "1.0.0".to_string(),
        kind,
        runtime,
        entrypoint_path: relative_entrypoint,
        sha256: file_hash,
        capabilities,
        model_family: None,
        size_bytes: Some(fs::metadata(&destination).map_err(err_to_string)?.len()),
        license: None,
        installed_at: Some(installed_at),
        metadata: if extension == "llamafile" {
            Some(json!({
                "serviceStartArgs": ["--server", "--port", "{port}", "--nobrowser"],
                "serviceHealthPath": "/health",
                "serviceCompletionPath": "/completion"
            }))
        } else {
            None
        },
    })
}

fn imported_asset_dir(app: &AppHandle, manifest: &PluginManifest) -> Result<Option<PathBuf>, String> {
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

#[tauri::command]
pub fn plugin_registry_init(app: AppHandle) -> Result<PluginRegistryState, String> {
    let paths = plugin_paths(&app)?;
    ensure_registry(&paths)?;
    let state = load_registry(&paths)?;
    save_registry(&paths, &state)?;
    Ok(state)
}

#[tauri::command]
pub fn plugin_registry_list(app: AppHandle) -> Result<Vec<PluginManifest>, String> {
    let paths = plugin_paths(&app)?;
    ensure_registry(&paths)?;
    let state = load_registry(&paths)?;
    Ok(state.plugins)
}

#[tauri::command]
pub fn plugin_registry_discover(
    app: AppHandle,
    request: PluginDiscoveryRequest,
) -> Result<Vec<PluginManifest>, String> {
    let paths = plugin_paths(&app)?;
    ensure_registry(&paths)?;
    let state = load_registry(&paths)?;

    let required = request.required_capabilities.unwrap_or_default();
    let mut discovered = Vec::new();
    for plugin in state.plugins {
        if let Some(role) = request.role.as_ref() {
            if !supports_role(&plugin, role.clone()) {
                continue;
            }
        }
        if !required
            .iter()
            .all(|capability| plugin.capabilities.iter().any(|item| item == capability))
        {
            continue;
        }
        discovered.push(plugin);
    }
    Ok(discovered)
}

#[tauri::command]
pub fn plugin_import_from_path(
    app: AppHandle,
    request: PluginImportRequest,
) -> Result<PluginManifest, String> {
    let manifest = imported_plugin_manifest(&app, &request)?;
    validate_manifest(&manifest)?;

    let paths = plugin_paths(&app)?;
    ensure_registry(&paths)?;
    let mut state = load_registry(&paths)?;

    if state
        .plugins
        .iter()
        .any(|plugin| plugin.plugin_id == manifest.plugin_id)
    {
        return Err(format!("Plugin already exists: {}", manifest.plugin_id));
    }

    state.plugins.push(manifest.clone());
    if state.active_providers.transform.is_none() && supports_role(&manifest, ProviderRole::Transform)
    {
        state.active_providers.transform = Some(manifest.plugin_id.clone());
    }

    save_registry(&paths, &state)?;
    Ok(manifest)
}

#[tauri::command]
pub fn plugin_registry_add(app: AppHandle, manifest: PluginManifest) -> Result<(), String> {
    validate_manifest(&manifest)?;

    let paths = plugin_paths(&app)?;
    ensure_registry(&paths)?;
    let mut state = load_registry(&paths)?;

    if state
        .plugins
        .iter()
        .any(|plugin| plugin.plugin_id == manifest.plugin_id)
    {
        return Err(format!("Plugin already exists: {}", manifest.plugin_id));
    }

    state.plugins.push(manifest.clone());

    if state.active_providers.transform.is_none() && supports_role(&manifest, ProviderRole::Transform) {
        state.active_providers.transform = Some(manifest.plugin_id.clone());
    }

    save_registry(&paths, &state)
}

#[tauri::command]
pub fn plugin_registry_remove(
    app: AppHandle,
    plugin_id: String,
    runtime_state: State<'_, PluginRuntimeState>,
) -> Result<(), String> {
    if plugin_id == BUILTIN_ORT_ASR_PLUGIN_ID {
        return Err("Built-in ASR plugin cannot be removed".to_string());
    }

    let paths = plugin_paths(&app)?;
    ensure_registry(&paths)?;
    let mut state = load_registry(&paths)?;

    let removed_plugin = state
        .plugins
        .iter()
        .position(|plugin| plugin.plugin_id == plugin_id)
        .map(|idx| state.plugins.remove(idx));
    let Some(removed_plugin) = removed_plugin else {
        return Err(format!("Unknown pluginId: {plugin_id}"));
    };

    if state.active_providers.asr.as_deref() == Some(plugin_id.as_str()) {
        state.active_providers.asr = Some(BUILTIN_ORT_ASR_PLUGIN_ID.to_string());
    }
    if state.active_providers.transform.as_deref() == Some(plugin_id.as_str()) {
        state.active_providers.transform = None;
    }

    save_registry(&paths, &state)?;
    let mut running = runtime_state
        .lock_running();
    stop_service(&mut running, &plugin_id)?;

    match imported_asset_dir(&app, &removed_plugin) {
        Ok(Some(asset_dir)) if asset_dir.exists() => {
            if let Err(error) = fs::remove_dir_all(&asset_dir) {
                eprintln!(
                    "Failed to remove imported assets for {} at {}: {}",
                    removed_plugin.plugin_id,
                    asset_dir.display(),
                    error
                );
            }
        }
        Ok(_) => {}
        Err(error) => {
            eprintln!(
                "Failed to resolve imported asset path for {}: {}",
                removed_plugin.plugin_id, error
            );
        }
    }

    Ok(())
}

#[tauri::command]
pub fn plugin_registry_active(app: AppHandle) -> Result<ActiveProviders, String> {
    let paths = plugin_paths(&app)?;
    ensure_registry(&paths)?;
    let state = load_registry(&paths)?;
    Ok(state.active_providers)
}

#[tauri::command]
pub fn plugin_registry_set_active(
    app: AppHandle,
    role: ProviderRole,
    plugin_id: Option<String>,
    runtime_state: State<'_, PluginRuntimeState>,
) -> Result<(), String> {
    let paths = plugin_paths(&app)?;
    ensure_registry(&paths)?;
    let mut state = load_registry(&paths)?;

    let previous_transform = state.active_providers.transform.clone();
    match role {
        ProviderRole::Asr => {
            let Some(plugin_id) = plugin_id else {
                return Err("role=asr requires a non-null pluginId".to_string());
            };
            let Some(plugin) = resolve_plugin(&state, &plugin_id) else {
                return Err(format!("Unknown pluginId: {plugin_id}"));
            };
            if !supports_role(plugin, ProviderRole::Asr) {
                return Err(format!("Plugin {plugin_id} cannot provide role asr"));
            }
            if plugin.plugin_id != BUILTIN_ORT_ASR_PLUGIN_ID {
                return Err(
                    "Activating imported ONNX ASR providers is not supported yet".to_string(),
                );
            }
            state.active_providers.asr = Some(plugin_id);
        }
        ProviderRole::Transform => {
            if let Some(plugin_id) = plugin_id {
                let Some(plugin) = resolve_plugin(&state, &plugin_id) else {
                    return Err(format!("Unknown pluginId: {plugin_id}"));
                };
                if !supports_role(plugin, ProviderRole::Transform) {
                    return Err(format!("Plugin {plugin_id} cannot provide role transform"));
                }
                state.active_providers.transform = Some(plugin_id);
            } else {
                state.active_providers.transform = None;
            }
        }
    }

    let next_transform = state.active_providers.transform.clone();
    save_registry(&paths, &state)?;

    if previous_transform != next_transform {
        if let Some(previous_id) = previous_transform {
            let mut running = runtime_state.lock_running();
            stop_service(&mut running, &previous_id)?;
        }
    }

    Ok(())
}

fn service_start_blocking(app: &AppHandle, plugin_id: &str) -> Result<RuntimeHealth, String> {
    let runtime_state = app.state::<PluginRuntimeState>();
    let paths = plugin_paths(app)?;
    ensure_registry(&paths)?;
    let state = load_registry(&paths)?;
    let Some(plugin) = resolve_plugin(&state, plugin_id) else {
        return Err(format!("Unknown pluginId: {plugin_id}"));
    };
    if plugin.runtime != PluginRuntime::Llamafile || plugin.kind != PluginKind::Llm {
        return Err(format!("Plugin {plugin_id} is not a llamafile LLM provider"));
    }

    let entrypoint = resolve_entrypoint(app, &plugin.entrypoint_path)?;
    if !entrypoint.exists() {
        return Err(format!("Entrypoint not found: {}", entrypoint.display()));
    }

    let health_path = service_health_path(&plugin.metadata);
    let endpoint = {
        let mut running = runtime_state.lock_running();

        let _ = cleanup_service_if_exited(&mut running, plugin_id)?;
        if let Some(service) = running.get(plugin_id) {
            return Ok(RuntimeHealth {
                ready: true,
                running: true,
                message: format!("Service already running for {plugin_id}"),
                pid: Some(service.child.id()),
                endpoint: Some(service.endpoint.clone()),
            });
        }

        let port = pick_open_port()?;
        let endpoint = format!("http://127.0.0.1:{port}");
        let args = service_start_args(&plugin.metadata, port);
        let child = Command::new(&entrypoint)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(err_to_string)?;

        running.insert(
            plugin_id.to_string(),
            RunningLlamafile {
                child,
                endpoint: endpoint.clone(),
            },
        );
        endpoint
    };

    if let Err(error) = wait_for_service_ready(&endpoint, &health_path) {
        let mut running = runtime_state.lock_running();
        let _ = stop_service(&mut running, plugin_id);
        return Err(error);
    }

    let mut running = runtime_state
        .lock_running();
    let _ = cleanup_service_if_exited(&mut running, plugin_id)?;
    let Some(service) = running.get(plugin_id) else {
        return Err("Service failed to remain running".to_string());
    };

    Ok(RuntimeHealth {
        ready: true,
        running: true,
        message: format!("Service started for {plugin_id}"),
        pid: Some(service.child.id()),
        endpoint: Some(service.endpoint.clone()),
    })
}

#[tauri::command]
pub async fn plugin_service_start(
    app: AppHandle,
    plugin_id: String,
) -> Result<RuntimeHealth, String> {
    tauri::async_runtime::spawn_blocking(move || service_start_blocking(&app, &plugin_id))
        .await
        .map_err(err_to_string)?
}

#[tauri::command]
pub fn plugin_service_status(
    app: AppHandle,
    plugin_id: String,
    runtime_state: State<'_, PluginRuntimeState>,
) -> Result<RuntimeHealth, String> {
    let paths = plugin_paths(&app)?;
    ensure_registry(&paths)?;
    let state = load_registry(&paths)?;
    let Some(plugin) = resolve_plugin(&state, &plugin_id) else {
        return Ok(RuntimeHealth {
            ready: false,
            running: false,
            message: "Plugin not found".to_string(),
            pid: None,
            endpoint: None,
        });
    };
    let entrypoint = resolve_entrypoint(&app, &plugin.entrypoint_path)?;
    if !entrypoint.exists() {
        return Ok(RuntimeHealth {
            ready: false,
            running: false,
            message: format!("Entrypoint not found: {}", entrypoint.display()),
            pid: None,
            endpoint: None,
        });
    }

    let mut running = runtime_state
        .lock_running();
    if let Some(exit_code) = cleanup_service_if_exited(&mut running, &plugin_id)? {
        return Ok(RuntimeHealth {
            ready: false,
            running: false,
            message: format!("Service exited with code {exit_code}"),
            pid: None,
            endpoint: None,
        });
    }

    let Some(service) = running.get(&plugin_id) else {
        return Ok(RuntimeHealth {
            ready: false,
            running: false,
            message: "Service is stopped".to_string(),
            pid: None,
            endpoint: None,
        });
    };

    Ok(RuntimeHealth {
        ready: true,
        running: true,
        message: format!("Service running for {plugin_id}"),
        pid: Some(service.child.id()),
        endpoint: Some(service.endpoint.clone()),
    })
}

#[tauri::command]
pub fn plugin_service_stop(
    plugin_id: String,
    runtime_state: State<'_, PluginRuntimeState>,
) -> Result<RuntimeHealth, String> {
    let mut running = runtime_state
        .lock_running();
    stop_service(&mut running, &plugin_id)?;
    Ok(RuntimeHealth {
        ready: false,
        running: false,
        message: format!("Service stopped for {plugin_id}"),
        pid: None,
        endpoint: None,
    })
}

#[tauri::command]
pub async fn plugin_runtime_llamafile_init(
    app: AppHandle,
    plugin_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        service_start_blocking(&app, &plugin_id).map(|_| ())
    })
    .await
    .map_err(err_to_string)?
}

#[tauri::command]
pub fn plugin_runtime_llamafile_health(
    app: AppHandle,
    plugin_id: String,
    runtime_state: State<'_, PluginRuntimeState>,
) -> Result<RuntimeHealth, String> {
    plugin_service_status(app, plugin_id, runtime_state)
}

fn llamafile_execute_blocking(
    app: &AppHandle,
    plugin_id: &str,
    capability: &str,
    input: &str,
    prompt: Option<String>,
) -> Result<RuntimeExecuteResult, String> {
    let runtime_state = app.state::<PluginRuntimeState>();
    let paths = plugin_paths(app)?;
    ensure_registry(&paths)?;
    let state = load_registry(&paths)?;
    let Some(plugin) = resolve_plugin(&state, plugin_id) else {
        return Err(format!("Unknown pluginId: {plugin_id}"));
    };
    if plugin.runtime != PluginRuntime::Llamafile || plugin.kind != PluginKind::Llm {
        return Err(format!("Plugin {plugin_id} is not a llamafile LLM provider"));
    }
    if !plugin.capabilities.iter().any(|item| item == capability) {
        return Err(format!(
            "Plugin {plugin_id} does not support capability {capability}"
        ));
    }

    let endpoint = {
        let mut running = runtime_state.lock_running();
        if let Some(exit_code) = cleanup_service_if_exited(&mut running, plugin_id)? {
            return Err(format!("Service exited with code {exit_code}"));
        }

        let Some(service) = running.get(plugin_id) else {
            return Err(format!("Service is not running for plugin {plugin_id}"));
        };
        service.endpoint.clone()
    };

    let completion_path = service_completion_path(&plugin.metadata);
    let prompt = prompt.unwrap_or_else(|| default_llamafile_prompt(capability));
    let full_prompt = format!("{prompt}\n\n{input}");
    let payload = if completion_path.starts_with("/v1/") {
        json!({
            "model": "local",
            "messages": [{ "role": "user", "content": full_prompt }],
            "temperature": 0.2
        })
    } else {
        json!({
            "prompt": full_prompt,
            "n_predict": 512,
            "temperature": 0.2
        })
    };

    let (status, response_text) = http_post_json(
        &endpoint,
        &completion_path,
        &payload,
        Duration::from_secs(90),
    )?;
    if status >= 400 {
        let trimmed = response_text.trim();
        let message = if trimmed.is_empty() {
            format!("Service request failed with HTTP {status}")
        } else {
            format!("Service request failed with HTTP {status}: {trimmed}")
        };
        return Err(message);
    }

    let payload: Value = serde_json::from_str(&response_text).map_err(err_to_string)?;
    let text = extract_completion_text(&payload)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Service response did not include text content".to_string())?;
    Ok(RuntimeExecuteResult { text })
}

#[tauri::command]
pub async fn plugin_runtime_llamafile_execute(
    app: AppHandle,
    plugin_id: String,
    capability: String,
    input: String,
    prompt: Option<String>,
) -> Result<RuntimeExecuteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        llamafile_execute_blocking(&app, &plugin_id, &capability, &input, prompt)
    })
    .await
    .map_err(err_to_string)?
}

#[tauri::command]
pub fn plugin_runtime_llamafile_shutdown(
    plugin_id: String,
    runtime_state: State<'_, PluginRuntimeState>,
) -> Result<(), String> {
    plugin_service_stop(plugin_id, runtime_state).map(|_| ())
}
