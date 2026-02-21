use super::PluginKind;

pub(super) fn is_supported_runtime(kind: &PluginKind, runtime: &str) -> bool {
    match kind {
        PluginKind::Asr => matches!(runtime, "ort-ctc" | "whisper"),
        PluginKind::Llm => matches!(runtime, "llamafile"),
    }
}

pub(super) fn is_valid_semver(value: &str) -> bool {
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
