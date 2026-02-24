use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::util::write_json_atomic;

use super::{
    err_to_string,
    manifest_utils::{is_supported_runtime, is_valid_semver},
    parse_string_field, ActivePlugins, PluginKind, PluginManifest, PluginRegistryState,
};

const REGISTRY_FORMAT: u8 = 1;
const REGISTRY_FILE_NAME: &str = "registry.json";
const LEGACY_BUILTIN_PLUGIN_PREFIX: &str = "builtin.";

#[derive(Debug, Clone)]
pub(super) struct PluginPaths {
    pub registry_file: PathBuf,
}

pub(super) fn plugin_paths(app: &AppHandle) -> Result<PluginPaths, String> {
    let root = app.path().app_data_dir().map_err(err_to_string)?;
    Ok(PluginPaths {
        registry_file: root.join("plugins").join(REGISTRY_FILE_NAME),
    })
}

pub(super) fn ensure_registry(paths: &PluginPaths) -> Result<(), String> {
    let Some(parent) = paths.registry_file.parent() else {
        return Err("Missing plugin registry directory".to_string());
    };
    fs::create_dir_all(parent).map_err(err_to_string)?;

    if !paths.registry_file.exists() {
        write_json_atomic(&paths.registry_file, &PluginRegistryState::default())
            .map_err(err_to_string)?;
    }

    Ok(())
}

pub(super) fn load_registry(paths: &PluginPaths) -> Result<PluginRegistryState, String> {
    let raw = fs::read_to_string(&paths.registry_file).map_err(err_to_string)?;
    let state: PluginRegistryState = serde_json::from_str(&raw).map_err(err_to_string)?;
    sanitize_registry(state)
}

pub(super) fn save_registry(
    paths: &PluginPaths,
    state: &PluginRegistryState,
) -> Result<(), String> {
    write_json_atomic(&paths.registry_file, state).map_err(err_to_string)
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

fn is_valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(super) fn validate_manifest(manifest: &PluginManifest) -> Result<(), String> {
    if !is_valid_plugin_id(&manifest.plugin_id) {
        return Err("pluginId must be 3-128 chars and use [A-Za-z0-9._-]".to_string());
    }
    if manifest
        .plugin_id
        .starts_with(LEGACY_BUILTIN_PLUGIN_PREFIX)
    {
        return Err("legacy builtin plugins are no longer supported".to_string());
    }
    if manifest.name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    if !is_valid_semver(&manifest.version) {
        return Err("version must follow semver x.y.z".to_string());
    }
    if manifest.runtime.trim().is_empty() {
        return Err("runtime is required".to_string());
    }
    if !is_supported_runtime(&manifest.kind, manifest.runtime.trim()) {
        return Err(format!(
            "runtime {} is not supported for kind {:?}",
            manifest.runtime, manifest.kind
        ));
    }
    if manifest.entrypoint_path.trim().is_empty() {
        return Err("entrypointPath is required".to_string());
    }
    if !Path::new(&manifest.entrypoint_path).is_absolute()
        && !manifest.entrypoint_path.starts_with("plugins/")
    {
        return Err("relative entrypointPath must start with plugins/".to_string());
    }
    if !is_valid_hash(&manifest.hash) {
        return Err("hash must be 64 lowercase hex chars".to_string());
    }

    if manifest.kind == PluginKind::Asr && manifest.runtime == "ort-ctc" {
        if parse_string_field(&manifest.metadata, "vocabPath")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .is_none()
        {
            return Err("asr plugins must include metadata.vocabPath".to_string());
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

    let has_asr_active = state
        .active_plugins
        .asr
        .as_ref()
        .map(|plugin_id| {
            valid_plugins
                .iter()
                .any(|plugin| plugin.plugin_id == *plugin_id && plugin.kind == PluginKind::Asr)
        })
        .unwrap_or(false);
    if !has_asr_active {
        state.active_plugins.asr = None;
    }

    let has_llm_active = state
        .active_plugins
        .llm
        .as_ref()
        .map(|plugin_id| {
            valid_plugins
                .iter()
                .any(|plugin| plugin.plugin_id == *plugin_id && plugin.kind == PluginKind::Llm)
        })
        .unwrap_or(false);
    if !has_llm_active {
        state.active_plugins.llm = None;
    }

    Ok(PluginRegistryState {
        format: REGISTRY_FORMAT,
        plugins: valid_plugins,
        active_plugins: state.active_plugins,
    })
}

pub(super) fn auto_activate_vacant(state: &mut PluginRegistryState, manifest: &PluginManifest) {
    match manifest.kind {
        PluginKind::Asr => {
            if state.active_plugins.asr.is_none() {
                state.active_plugins.asr = Some(manifest.plugin_id.clone());
            }
        }
        PluginKind::Llm => {
            if state.active_plugins.llm.is_none() {
                state.active_plugins.llm = Some(manifest.plugin_id.clone());
            }
        }
    }
}

pub(super) fn resolve_plugin<'a>(
    state: &'a PluginRegistryState,
    plugin_id: &str,
) -> Option<&'a PluginManifest> {
    state
        .plugins
        .iter()
        .find(|plugin| plugin.plugin_id == plugin_id)
}

pub(super) fn resolve_entrypoint(
    app: &AppHandle,
    entrypoint_path: &str,
) -> Result<PathBuf, String> {
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

    // Imported plugin assets live under plugins/ in the app data directory.
    // Relative entrypoints outside plugins/ are rejected.
    if entrypoint_path.starts_with("plugins/") {
        let app_data = app.path().app_data_dir().map_err(err_to_string)?;
        return Ok(app_data.join(candidate));
    }

    Err("relative entrypointPath must start with plugins/".to_string())
}

impl Default for PluginRegistryState {
    fn default() -> Self {
        Self {
            format: REGISTRY_FORMAT,
            plugins: Vec::new(),
            active_plugins: ActivePlugins {
                asr: None,
                llm: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{sanitize_registry, validate_manifest, REGISTRY_FORMAT};
    use crate::plugins::{ActivePlugins, PluginKind, PluginManifest, PluginRegistryState};
    use serde_json::json;

    fn manifest(
        plugin_id: &str,
        kind: PluginKind,
        runtime: &str,
        entrypoint_path: &str,
        metadata: Option<serde_json::Value>,
    ) -> PluginManifest {
        PluginManifest {
            plugin_id: plugin_id.to_string(),
            name: "Plugin".to_string(),
            version: "1.0.0".to_string(),
            kind,
            runtime: runtime.to_string(),
            entrypoint_path: entrypoint_path.to_string(),
            hash: "a".repeat(64),
            model_family: None,
            size_bytes: None,
            license: None,
            installed_at: None,
            metadata,
        }
    }

    #[test]
    fn validate_manifest_rejects_legacy_builtin_id() {
        let legacy = manifest(
            "builtin.asr.ort.medasr",
            PluginKind::Asr,
            "ort-ctc",
            "plugins/assets/import.asr.test/model.onnx",
            Some(json!({
                "vocabPath": "plugins/assets/import.asr.test/vocab.json"
            })),
        );

        let result = validate_manifest(&legacy);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "legacy builtin plugins are no longer supported"
        );
    }

    #[test]
    fn sanitize_registry_removes_legacy_entries_and_clears_active_asr() {
        let legacy = manifest(
            "builtin.asr.ort.medasr",
            PluginKind::Asr,
            "ort-ctc",
            "models/medasr.onnx",
            Some(json!({ "vocabPath": "models/medasr_vocab.json" })),
        );
        let imported = manifest(
            "import.asr.ort.test.1",
            PluginKind::Asr,
            "ort-ctc",
            "plugins/assets/import.asr.ort.test.1/model.onnx",
            Some(json!({
                "vocabPath": "plugins/assets/import.asr.ort.test.1/vocab.json"
            })),
        );
        let state = PluginRegistryState {
            format: REGISTRY_FORMAT,
            plugins: vec![legacy, imported.clone()],
            active_plugins: ActivePlugins {
                asr: Some("builtin.asr.ort.medasr".to_string()),
                llm: None,
            },
        };

        let sanitized = sanitize_registry(state).expect("registry should sanitize");
        assert_eq!(sanitized.plugins.len(), 1);
        assert_eq!(sanitized.plugins[0].plugin_id, imported.plugin_id);
        assert_eq!(sanitized.active_plugins.asr, None);
    }
}
