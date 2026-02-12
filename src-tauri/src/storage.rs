use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const STORAGE_FORMAT: u8 = 1;
const INDEX_FILE_NAME: &str = "sessions.json";
const SESSION_FILE_NAME: &str = "session.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    TranscriptRaw,
    TranscriptCorrected,
    AudioCapture,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub artifact_id: String,
    pub kind: ArtifactKind,
    pub role: String,
    pub content_type: String,
    pub path: String,
    pub created_at: String,
    pub created_by: String,
    pub source_artifact_id: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub format: u8,
    pub session_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub active_artifact_id: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<ArtifactRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub session_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub active_artifact_id: Option<String>,
    pub artifact_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIndex {
    format: u8,
    sessions: Vec<SessionIndexEntry>,
}

impl Default for SessionIndex {
    fn default() -> Self {
        Self {
            format: STORAGE_FORMAT,
            sessions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInitResult {
    app_data_dir: String,
    removed_temp_files: usize,
    skipped_invalid_sessions: usize,
    missing_artifacts: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArtifactTextRequest {
    session_id: String,
    artifact_id: String,
    extension: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArtifactTextResult {
    path: String,
    size_bytes: usize,
}

#[derive(Debug, Clone)]
struct StoragePaths {
    root: PathBuf,
    sessions_dir: PathBuf,
    index_file: PathBuf,
}

fn err_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn storage_paths(app: &AppHandle) -> Result<StoragePaths, String> {
    let root = app.path().app_data_dir().map_err(err_to_string)?;
    Ok(StoragePaths {
        sessions_dir: root.join("sessions"),
        index_file: root.join("index").join(INDEX_FILE_NAME),
        root,
    })
}

fn ensure_storage(paths: &StoragePaths) -> Result<(), String> {
    fs::create_dir_all(&paths.sessions_dir).map_err(err_to_string)?;

    let Some(index_dir) = paths.index_file.parent() else {
        return Err("Missing index directory".to_string());
    };
    fs::create_dir_all(index_dir).map_err(err_to_string)?;

    if !paths.index_file.exists() {
        write_json_atomic(&paths.index_file, &SessionIndex::default()).map_err(err_to_string)?;
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

fn session_dir(paths: &StoragePaths, session_id: &str) -> PathBuf {
    paths.sessions_dir.join(session_id)
}

fn session_file(paths: &StoragePaths, session_id: &str) -> PathBuf {
    session_dir(paths, session_id).join(SESSION_FILE_NAME)
}

fn artifacts_dir(paths: &StoragePaths, session_id: &str) -> PathBuf {
    session_dir(paths, session_id).join("artifacts")
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn sanitize_extension(extension: &str) -> Option<String> {
    let value = extension.trim().trim_start_matches('.');
    if value.is_empty() || value.len() > 16 {
        return None;
    }
    if !value.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

fn is_safe_relative_path(path: &str) -> bool {
    let parsed = Path::new(path);
    !parsed.is_absolute() && !path.contains("..")
}

fn is_session_artifact_path(session_id: &str, path: &str) -> bool {
    path.starts_with(&format!("sessions/{session_id}/artifacts/"))
}

fn build_index_entry(session: &SessionRecord) -> SessionIndexEntry {
    SessionIndexEntry {
        session_id: session.session_id.clone(),
        created_at: session.created_at.clone(),
        updated_at: session.updated_at.clone(),
        active_artifact_id: session.active_artifact_id.clone(),
        artifact_count: session.artifacts.len(),
    }
}

fn validate_session(session: &SessionRecord) -> Result<(), String> {
    if session.format != STORAGE_FORMAT {
        return Err(format!(
            "Unsupported session format {}, expected {}",
            session.format, STORAGE_FORMAT
        ));
    }

    if !is_safe_id(&session.session_id) {
        return Err("Invalid session id".to_string());
    }

    if let Some(active_artifact_id) = &session.active_artifact_id {
        if !session
            .artifacts
            .iter()
            .any(|artifact| artifact.artifact_id == *active_artifact_id)
        {
            return Err("activeArtifactId must reference an existing artifact".to_string());
        }
    }

    for artifact in &session.artifacts {
        if !is_safe_id(&artifact.artifact_id) {
            return Err("Invalid artifact id".to_string());
        }

        if let Some(source_artifact_id) = &artifact.source_artifact_id {
            if !is_safe_id(source_artifact_id) {
                return Err("Invalid sourceArtifactId".to_string());
            }
        }

        if !is_safe_relative_path(&artifact.path)
            || !is_session_artifact_path(&session.session_id, &artifact.path)
        {
            return Err("Invalid artifact path".to_string());
        }
    }

    Ok(())
}

fn list_session_entries_from_files(paths: &StoragePaths) -> Result<Vec<SessionIndexEntry>, String> {
    let mut sessions = Vec::new();
    if !paths.sessions_dir.exists() {
        return Ok(sessions);
    }

    for item in fs::read_dir(&paths.sessions_dir).map_err(err_to_string)? {
        let item = item.map_err(err_to_string)?;
        let item_type = item.file_type().map_err(err_to_string)?;
        if !item_type.is_dir() {
            continue;
        }

        let folder_name = item.file_name();
        let folder_name = folder_name.to_string_lossy().to_string();
        if !is_safe_id(&folder_name) {
            continue;
        }

        let file_path = item.path().join(SESSION_FILE_NAME);
        if !file_path.exists() {
            continue;
        }

        let Ok(raw) = fs::read_to_string(&file_path) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<SessionRecord>(&raw) else {
            continue;
        };
        if session.format != STORAGE_FORMAT || session.session_id != folder_name {
            continue;
        }

        sessions.push(build_index_entry(&session));
    }

    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub fn storage_init(app: AppHandle) -> Result<StorageInitResult, String> {
    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;

    Ok(StorageInitResult {
        app_data_dir: paths.root.display().to_string(),
        removed_temp_files: 0,
        skipped_invalid_sessions: 0,
        missing_artifacts: 0,
    })
}

#[tauri::command]
pub fn storage_list_sessions(app: AppHandle) -> Result<Vec<SessionIndexEntry>, String> {
    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;
    list_session_entries_from_files(&paths)
}

#[tauri::command]
pub fn storage_get_session(
    app: AppHandle,
    session_id: String,
) -> Result<Option<SessionRecord>, String> {
    if !is_safe_id(&session_id) {
        return Err("Invalid session id".to_string());
    }

    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;

    let file_path = session_file(&paths, &session_id);
    if !file_path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&file_path).map_err(err_to_string)?;
    let session = serde_json::from_str::<SessionRecord>(&raw).map_err(err_to_string)?;
    validate_session(&session)?;
    if session.session_id != session_id {
        return Err("Session id mismatch".to_string());
    }
    Ok(Some(session))
}

#[tauri::command]
pub fn storage_save_session(app: AppHandle, session: SessionRecord) -> Result<(), String> {
    validate_session(&session)?;

    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;
    let dir_path = session_dir(&paths, &session.session_id);
    fs::create_dir_all(&dir_path).map_err(err_to_string)?;
    fs::create_dir_all(artifacts_dir(&paths, &session.session_id)).map_err(err_to_string)?;

    let file_path = dir_path.join(SESSION_FILE_NAME);
    write_json_atomic(&file_path, &session).map_err(err_to_string)?;

    Ok(())
}

#[tauri::command]
pub fn storage_write_artifact_text(
    app: AppHandle,
    request: WriteArtifactTextRequest,
) -> Result<WriteArtifactTextResult, String> {
    if !is_safe_id(&request.session_id) {
        return Err("Invalid session id".to_string());
    }
    if !is_safe_id(&request.artifact_id) {
        return Err("Invalid artifact id".to_string());
    }

    let Some(extension) = sanitize_extension(&request.extension) else {
        return Err("Invalid extension".to_string());
    };

    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;
    let artifact_directory = artifacts_dir(&paths, &request.session_id);
    fs::create_dir_all(&artifact_directory).map_err(err_to_string)?;

    let file_name = format!("{}.{}", request.artifact_id, extension);
    let file_path = artifact_directory.join(&file_name);
    write_bytes_atomic(&file_path, request.text.as_bytes()).map_err(err_to_string)?;

    Ok(WriteArtifactTextResult {
        path: format!("sessions/{}/artifacts/{}", request.session_id, file_name),
        size_bytes: request.text.len(),
    })
}
