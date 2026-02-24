pub mod asr;
mod import;
mod llamafile;
mod manifest_utils;
mod registry;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State};

use asr::RunningAsr;
use import::{imported_asset_dir, imported_plugin_manifest};
use llamafile::{
    execute_blocking, service_start_blocking, service_status_blocking, stop_service,
    RunningLlamafile,
};
use registry::{
    auto_activate_vacant, ensure_registry, load_registry, plugin_paths, resolve_entrypoint,
    resolve_plugin, save_registry, validate_manifest,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Asr,
    Llm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub plugin_id: String,
    pub name: String,
    pub version: String,
    pub kind: PluginKind,
    pub runtime: String,
    pub entrypoint_path: String,
    #[serde(alias = "sha256")]
    pub hash: String,
    pub model_family: Option<String>,
    pub size_bytes: Option<u64>,
    pub license: Option<String>,
    pub installed_at: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivePlugins {
    pub asr: Option<String>,
    pub llm: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryState {
    pub format: u8,
    pub plugins: Vec<PluginManifest>,
    pub active_plugins: ActivePlugins,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiscoveryRequest {
    pub kind: Option<PluginKind>,
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
    running_asr: Mutex<HashMap<String, RunningAsr>>,
}

impl PluginRuntimeState {
    fn lock_running(&self) -> MutexGuard<'_, HashMap<String, RunningLlamafile>> {
        self.running_llamafile
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn lock_running_asr(&self) -> MutexGuard<'_, HashMap<String, RunningAsr>> {
        self.running_asr.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn stop_all_running(&self) {
        let mut running = self.lock_running();
        for (plugin_id, mut service) in running.drain() {
            if let Err(error) = service.child.kill() {
                eprintln!("Failed to kill service for {plugin_id}: {error}");
            }
            if let Err(error) = service.child.wait() {
                eprintln!("Failed to wait on service for {plugin_id}: {error}");
            }
        }

        let mut running_asr = self.lock_running_asr();
        running_asr.drain();
    }
}

impl Drop for PluginRuntimeState {
    fn drop(&mut self) {
        self.stop_all_running();
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginImportRequest {
    pub source_path: String,
    pub display_name: Option<String>,
}

fn err_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
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

fn parse_runtime_config_string_field(metadata: &Option<Value>, field: &str) -> Option<String> {
    let Some(Value::Object(map)) = metadata else {
        return None;
    };
    let Some(Value::Object(runtime_config)) = map.get("runtimeConfig") else {
        return None;
    };
    let Some(Value::String(value)) = runtime_config.get(field) else {
        return None;
    };
    Some(value.clone())
}

fn parse_runtime_config_bool_field(metadata: &Option<Value>, field: &str) -> Option<bool> {
    let Some(Value::Object(map)) = metadata else {
        return None;
    };
    let Some(Value::Object(runtime_config)) = map.get("runtimeConfig") else {
        return None;
    };
    let Some(Value::Bool(value)) = runtime_config.get(field) else {
        return None;
    };
    Some(*value)
}

// -- Tauri commands --

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

    let mut discovered = Vec::new();
    for plugin in state.plugins {
        if let Some(ref kind) = request.kind {
            if plugin.kind != *kind {
                continue;
            }
        }
        discovered.push(plugin);
    }
    Ok(discovered)
}

#[tauri::command]
pub async fn plugin_import_from_path(
    app: AppHandle,
    request: PluginImportRequest,
) -> Result<PluginManifest, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
        auto_activate_vacant(&mut state, &manifest);

        save_registry(&paths, &state)?;
        Ok(manifest)
    })
    .await
    .map_err(err_to_string)?
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
    auto_activate_vacant(&mut state, &manifest);

    save_registry(&paths, &state)
}

#[tauri::command]
pub fn plugin_registry_remove(
    app: AppHandle,
    plugin_id: String,
    runtime_state: State<'_, PluginRuntimeState>,
) -> Result<(), String> {
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

    if state.active_plugins.asr.as_deref() == Some(plugin_id.as_str()) {
        state.active_plugins.asr = None;
    }
    if state.active_plugins.llm.as_deref() == Some(plugin_id.as_str()) {
        state.active_plugins.llm = None;
    }

    save_registry(&paths, &state)?;
    let mut running = runtime_state.lock_running();
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
pub fn plugin_registry_active(app: AppHandle) -> Result<ActivePlugins, String> {
    let paths = plugin_paths(&app)?;
    ensure_registry(&paths)?;
    let state = load_registry(&paths)?;
    Ok(state.active_plugins)
}

#[tauri::command]
pub fn plugin_registry_set_active(
    app: AppHandle,
    kind: PluginKind,
    plugin_id: Option<String>,
    runtime_state: State<'_, PluginRuntimeState>,
) -> Result<(), String> {
    let paths = plugin_paths(&app)?;
    ensure_registry(&paths)?;
    let mut state = load_registry(&paths)?;

    let previous_llm = state.active_plugins.llm.clone();
    match kind {
        PluginKind::Asr => {
            if let Some(plugin_id) = plugin_id {
                let Some(plugin) = resolve_plugin(&state, &plugin_id) else {
                    return Err(format!("Unknown pluginId: {plugin_id}"));
                };
                if plugin.kind != PluginKind::Asr {
                    return Err(format!("Plugin {plugin_id} is not of kind asr"));
                }
                state.active_plugins.asr = Some(plugin_id);
            } else {
                state.active_plugins.asr = None;
            }
        }
        PluginKind::Llm => {
            if let Some(plugin_id) = plugin_id {
                let Some(plugin) = resolve_plugin(&state, &plugin_id) else {
                    return Err(format!("Unknown pluginId: {plugin_id}"));
                };
                if plugin.kind != PluginKind::Llm {
                    return Err(format!("Plugin {plugin_id} is not of kind llm"));
                }
                state.active_plugins.llm = Some(plugin_id);
            } else {
                state.active_plugins.llm = None;
            }
        }
    }

    let next_llm = state.active_plugins.llm.clone();
    save_registry(&paths, &state)?;

    if previous_llm != next_llm {
        if let Some(previous_id) = previous_llm {
            let mut running = runtime_state.lock_running();
            stop_service(&mut running, &previous_id)?;
        }
    }

    Ok(())
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
    service_status_blocking(&app, &plugin_id, &runtime_state)
}

#[tauri::command]
pub fn plugin_service_stop(
    plugin_id: String,
    runtime_state: State<'_, PluginRuntimeState>,
) -> Result<RuntimeHealth, String> {
    let mut running = runtime_state.lock_running();
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
pub async fn plugin_runtime_llamafile_execute(
    app: AppHandle,
    plugin_id: String,
    action: String,
    input: String,
    prompt: Option<String>,
) -> Result<RuntimeExecuteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        execute_blocking(&app, &plugin_id, &action, &input, prompt)
    })
    .await
    .map_err(err_to_string)?
}

#[tauri::command]
pub async fn plugin_asr_load(app: AppHandle, plugin_id: String) -> Result<RuntimeHealth, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime_state = app.state::<PluginRuntimeState>();

        // Already loaded?
        {
            let running = runtime_state.lock_running_asr();
            if running.contains_key(&plugin_id) {
                return Ok(RuntimeHealth {
                    ready: true,
                    running: true,
                    message: format!("ASR session already loaded for {plugin_id}"),
                    pid: None,
                    endpoint: None,
                });
            }
        }

        let paths = plugin_paths(&app)?;
        ensure_registry(&paths)?;
        let state = load_registry(&paths)?;
        let Some(plugin) = resolve_plugin(&state, &plugin_id) else {
            return Err(format!("Unknown pluginId: {plugin_id}"));
        };
        if plugin.kind != PluginKind::Asr {
            return Err(format!("Plugin {plugin_id} is not an ASR plugin"));
        }

        let model_path = resolve_entrypoint(&app, &plugin.entrypoint_path)?;
        if !model_path.exists() {
            return Err(format!("Model file not found: {}", model_path.display()));
        }

        let model_str = model_path.to_string_lossy().to_string();
        let session = match plugin.runtime.as_str() {
            "ort-ctc" => {
                let vocab_rel = parse_string_field(&plugin.metadata, "vocabPath")
                    .ok_or_else(|| format!("Plugin {plugin_id} missing metadata.vocabPath"))?;
                let vocab_path = resolve_entrypoint(&app, &vocab_rel)?;
                if !vocab_path.exists() {
                    return Err(format!("Vocab file not found: {}", vocab_path.display()));
                }

                let vocab_str = vocab_path.to_string_lossy().to_string();
                asr::load_ctc_session(&model_str, &vocab_str)?
            }
            "whisper" => {
                let whisper_config = asr::WhisperRuntimeConfig {
                    language: asr::normalize_optional_text(parse_runtime_config_string_field(
                        &plugin.metadata,
                        "language",
                    )),
                    translate: parse_runtime_config_bool_field(&plugin.metadata, "translate")
                        .unwrap_or(false),
                    initial_prompt: asr::normalize_optional_text(
                        parse_runtime_config_string_field(&plugin.metadata, "initialPrompt"),
                    ),
                };
                asr::load_whisper_session(&model_str, whisper_config)?
            }
            runtime => {
                return Err(format!(
                    "ASR runtime {runtime} is not supported yet for {plugin_id}",
                ));
            }
        };

        let mut running = runtime_state.lock_running_asr();
        running.insert(plugin_id.clone(), session);

        Ok(RuntimeHealth {
            ready: true,
            running: true,
            message: format!("Native ASR loaded for {plugin_id}"),
            pid: None,
            endpoint: None,
        })
    })
    .await
    .map_err(err_to_string)?
}

#[tauri::command]
pub async fn plugin_asr_transcribe(
    app: AppHandle,
    plugin_id: String,
    samples: Vec<f32>,
) -> Result<RuntimeExecuteResult, String> {
    // Grab a clone so we don't hold the runtime-state lock during inference.
    let session = {
        let runtime_state = app.state::<PluginRuntimeState>();
        let running = runtime_state.lock_running_asr();
        let Some(running_asr) = running.get(&plugin_id).cloned() else {
            return Err(format!("ASR session not loaded for {plugin_id}"));
        };
        running_asr
    };

    tauri::async_runtime::spawn_blocking(move || asr::transcribe(&session, &samples))
        .await
        .map_err(err_to_string)?
}

#[tauri::command]
pub fn plugin_asr_unload(plugin_id: String, runtime_state: State<'_, PluginRuntimeState>) {
    let mut running = runtime_state.lock_running_asr();
    asr::unload(&mut running, &plugin_id);
}

