use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const STORAGE_FORMAT: u8 = 1;
const RECORDING_FILE_NAME: &str = "recording.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    TranscriptRaw,
    TranscriptCorrected,
    AudioCapture,
    ContextNote,
    SoapNote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentRole {
    Source,
    Derived,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentCreator {
    Asr,
    Llm,
    User,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub attachment_id: String,
    pub kind: AttachmentKind,
    pub role: AttachmentRole,
    pub content_type: String,
    pub path: String,
    pub created_at: String,
    pub created_by: AttachmentCreator,
    pub source_attachment_id: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub format: u8,
    pub recording_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub active_attachment_id: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingIndexEntry {
    pub recording_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub active_attachment_id: Option<String>,
    pub attachment_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInitResult {
    app_data_dir: String,
    removed_temp_files: usize,
    skipped_invalid_recordings: usize,
    missing_attachments: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteAttachmentTextRequest {
    recording_id: String,
    attachment_id: String,
    extension: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteAttachmentTextResult {
    path: String,
    size_bytes: usize,
}

#[derive(Debug, Clone)]
struct StoragePaths {
    root: PathBuf,
    recordings_dir: PathBuf,
}

fn err_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn storage_paths(app: &AppHandle) -> Result<StoragePaths, String> {
    let root = app.path().app_data_dir().map_err(err_to_string)?;
    Ok(StoragePaths {
        recordings_dir: root.join("recordings"),
        root,
    })
}

fn ensure_storage(paths: &StoragePaths) -> Result<(), String> {
    fs::create_dir_all(&paths.recordings_dir).map_err(err_to_string)?;
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

fn recording_dir(paths: &StoragePaths, recording_id: &str) -> PathBuf {
    paths.recordings_dir.join(recording_id)
}

fn recording_file(paths: &StoragePaths, recording_id: &str) -> PathBuf {
    recording_dir(paths, recording_id).join(RECORDING_FILE_NAME)
}

fn attachments_dir(paths: &StoragePaths, recording_id: &str) -> PathBuf {
    recording_dir(paths, recording_id).join("attachments")
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

fn is_recording_attachment_path(recording_id: &str, path: &str) -> bool {
    path.starts_with(&format!("recordings/{recording_id}/attachments/"))
}

fn build_index_entry(recording: &Recording) -> RecordingIndexEntry {
    RecordingIndexEntry {
        recording_id: recording.recording_id.clone(),
        created_at: recording.created_at.clone(),
        updated_at: recording.updated_at.clone(),
        active_attachment_id: recording.active_attachment_id.clone(),
        attachment_count: recording.attachments.len(),
    }
}

fn validate_recording(recording: &Recording) -> Result<(), String> {
    if recording.format != STORAGE_FORMAT {
        return Err(format!(
            "Unsupported recording format {}, expected {}",
            recording.format, STORAGE_FORMAT
        ));
    }

    if !is_safe_id(&recording.recording_id) {
        return Err("Invalid recording id".to_string());
    }

    if let Some(active_attachment_id) = &recording.active_attachment_id {
        if !recording
            .attachments
            .iter()
            .any(|attachment| attachment.attachment_id == *active_attachment_id)
        {
            return Err("activeAttachmentId must reference an existing attachment".to_string());
        }
    }

    for attachment in &recording.attachments {
        if !is_safe_id(&attachment.attachment_id) {
            return Err("Invalid attachment id".to_string());
        }

        if let Some(source_attachment_id) = &attachment.source_attachment_id {
            if !is_safe_id(source_attachment_id) {
                return Err("Invalid sourceAttachmentId".to_string());
            }
        }

        if !is_safe_relative_path(&attachment.path)
            || !is_recording_attachment_path(&recording.recording_id, &attachment.path)
        {
            return Err("Invalid attachment path".to_string());
        }
    }

    Ok(())
}

fn list_recording_entries_from_files(paths: &StoragePaths) -> Result<Vec<RecordingIndexEntry>, String> {
    let mut recordings = Vec::new();
    if !paths.recordings_dir.exists() {
        return Ok(recordings);
    }

    for item in fs::read_dir(&paths.recordings_dir).map_err(err_to_string)? {
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

        let file_path = item.path().join(RECORDING_FILE_NAME);
        if !file_path.exists() {
            continue;
        }

        let Ok(raw) = fs::read_to_string(&file_path) else {
            continue;
        };
        let Ok(recording) = serde_json::from_str::<Recording>(&raw) else {
            continue;
        };
        if recording.format != STORAGE_FORMAT || recording.recording_id != folder_name {
            continue;
        }

        recordings.push(build_index_entry(&recording));
    }

    recordings.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(recordings)
}

#[tauri::command]
pub fn storage_init(app: AppHandle) -> Result<StorageInitResult, String> {
    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;

    Ok(StorageInitResult {
        app_data_dir: paths.root.display().to_string(),
        removed_temp_files: 0,
        skipped_invalid_recordings: 0,
        missing_attachments: 0,
    })
}

#[tauri::command]
pub fn storage_list_recordings(app: AppHandle) -> Result<Vec<RecordingIndexEntry>, String> {
    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;
    list_recording_entries_from_files(&paths)
}

#[tauri::command]
pub fn storage_get_recording(
    app: AppHandle,
    recording_id: String,
) -> Result<Option<Recording>, String> {
    if !is_safe_id(&recording_id) {
        return Err("Invalid recording id".to_string());
    }

    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;

    let file_path = recording_file(&paths, &recording_id);
    if !file_path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&file_path).map_err(err_to_string)?;
    let recording = serde_json::from_str::<Recording>(&raw).map_err(err_to_string)?;
    validate_recording(&recording)?;
    if recording.recording_id != recording_id {
        return Err("Recording id mismatch".to_string());
    }
    Ok(Some(recording))
}

#[tauri::command]
pub fn storage_save_recording(app: AppHandle, recording: Recording) -> Result<(), String> {
    validate_recording(&recording)?;

    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;
    let dir_path = recording_dir(&paths, &recording.recording_id);
    fs::create_dir_all(&dir_path).map_err(err_to_string)?;
    fs::create_dir_all(attachments_dir(&paths, &recording.recording_id)).map_err(err_to_string)?;

    let file_path = dir_path.join(RECORDING_FILE_NAME);
    write_json_atomic(&file_path, &recording).map_err(err_to_string)?;

    Ok(())
}

#[tauri::command]
pub fn storage_delete_recording(app: AppHandle, recording_id: String) -> Result<(), String> {
    if !is_safe_id(&recording_id) {
        return Err("Invalid recording id".to_string());
    }

    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;

    let dir_path = recording_dir(&paths, &recording_id);
    if !dir_path.exists() {
        return Ok(());
    }

    fs::remove_dir_all(&dir_path).map_err(err_to_string)?;
    Ok(())
}

#[tauri::command]
pub fn storage_read_text(app: AppHandle, path: String) -> Result<String, String> {
    if !is_safe_relative_path(&path) || !path.starts_with("recordings/") {
        return Err("Invalid path".to_string());
    }

    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;
    let full_path = paths.root.join(&path);
    fs::read_to_string(full_path).map_err(err_to_string)
}

#[tauri::command]
pub fn storage_write_attachment_text(
    app: AppHandle,
    request: WriteAttachmentTextRequest,
) -> Result<WriteAttachmentTextResult, String> {
    if !is_safe_id(&request.recording_id) {
        return Err("Invalid recording id".to_string());
    }
    if !is_safe_id(&request.attachment_id) {
        return Err("Invalid attachment id".to_string());
    }

    let Some(extension) = sanitize_extension(&request.extension) else {
        return Err("Invalid extension".to_string());
    };

    let paths = storage_paths(&app)?;
    ensure_storage(&paths)?;
    let attachment_directory = attachments_dir(&paths, &request.recording_id);
    fs::create_dir_all(&attachment_directory).map_err(err_to_string)?;

    let file_name = format!("{}.{}", request.attachment_id, extension);
    let file_path = attachment_directory.join(&file_name);
    write_bytes_atomic(&file_path, request.text.as_bytes()).map_err(err_to_string)?;

    Ok(WriteAttachmentTextResult {
        path: format!("recordings/{}/attachments/{}", request.recording_id, file_name),
        size_bytes: request.text.len(),
    })
}
