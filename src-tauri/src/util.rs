use serde::Serialize;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos}-{}", std::process::id())
}

pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
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

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let encoded = serde_json::to_vec_pretty(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_bytes_atomic(path, &encoded)
}
