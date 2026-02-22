use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;
use std::sync::{Arc, Mutex};

use ort::value::Tensor;
use realfft::{RealFftPlanner, RealToComplex};
use serde::Deserialize;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use super::RuntimeExecuteResult;

const SAMPLE_RATE: f64 = 16000.0;
const FRAME_LEN: usize = 400;
const HOP_LEN: usize = 160;
const N_FFT: usize = 512;
const N_MELS: usize = 128;
const MEL_LOWER: f64 = 125.0;
const MEL_UPPER: f64 = 7500.0;

#[derive(Debug, Deserialize)]
struct VocabJson {
    blank_id: Option<usize>,
    eos_token_id: Option<usize>,
    tokens: Vec<String>,
}

pub struct AsrVocab {
    tokens: Vec<String>,
    blank_id: usize,
    eos_id: usize,
    special_ids: HashSet<usize>,
}

pub struct CtcSession {
    session: Mutex<ort::session::Session>,
    vocab: AsrVocab,
    mel_filterbank: Vec<f64>,
    hann_window: Vec<f64>,
    fft_plan: Arc<dyn RealToComplex<f64>>,
}

pub struct WhisperSession {
    _context: WhisperContext,
    state: Mutex<WhisperState>,
    runtime_config: WhisperRuntimeConfig,
}

#[derive(Debug, Clone, Default)]
pub struct WhisperRuntimeConfig {
    pub language: Option<String>,
    pub translate: bool,
    pub initial_prompt: Option<String>,
}

#[derive(Clone)]
pub enum RunningAsr {
    Ctc(Arc<CtcSession>),
    Whisper(Arc<WhisperSession>),
}

fn hertz_to_mel(freq: f64) -> f64 {
    1127.0 * (1.0 + freq / 700.0).ln()
}

fn build_mel_filterbank() -> Vec<f64> {
    let num_spec_bins = N_FFT / 2 + 1;
    let bands_to_zero: usize = 1;
    let nyquist = SAMPLE_RATE / 2.0;

    let num_active = num_spec_bins - bands_to_zero;
    let mut linear_freqs = vec![0.0f64; num_active];
    for i in 0..num_active {
        linear_freqs[i] = ((i + bands_to_zero) as f64 / (num_spec_bins - 1) as f64) * nyquist;
    }

    let mut spec_bins_mel = vec![0.0f64; num_active];
    for i in 0..num_active {
        spec_bins_mel[i] = hertz_to_mel(linear_freqs[i]);
    }

    let mel_lower = hertz_to_mel(MEL_LOWER);
    let mel_upper = hertz_to_mel(MEL_UPPER);
    let num_edges = N_MELS + 2;
    let mut edges = vec![0.0f64; num_edges];
    for i in 0..num_edges {
        edges[i] = mel_lower + (i as f64 / (N_MELS + 1) as f64) * (mel_upper - mel_lower);
    }

    let mut filterbank = vec![0.0f64; num_spec_bins * N_MELS];
    for spec_idx in 0..num_active {
        let mel = spec_bins_mel[spec_idx];
        for mel_idx in 0..N_MELS {
            let lower = edges[mel_idx];
            let center = edges[mel_idx + 1];
            let upper = edges[mel_idx + 2];
            let lower_slope = (mel - lower) / (center - lower);
            let upper_slope = (upper - mel) / (upper - center);
            let value = lower_slope.min(upper_slope).max(0.0);
            filterbank[(spec_idx + bands_to_zero) * N_MELS + mel_idx] = value;
        }
    }

    filterbank
}

fn build_hann_window() -> Vec<f64> {
    let mut window = vec![0.0f64; FRAME_LEN];
    for i in 0..FRAME_LEN {
        window[i] = 0.5 * (1.0 - (2.0 * PI * i as f64 / FRAME_LEN as f64).cos());
    }
    window
}

fn is_special_token(token: &str) -> bool {
    if token.is_empty() {
        return true;
    }
    // <...> where inner content has no angle brackets
    if token.starts_with('<') && token.ends_with('>') && token.len() > 2 {
        let inner = &token[1..token.len() - 1];
        if !inner.contains('<') && !inner.contains('>') {
            return true;
        }
    }
    if token.starts_with('{') && token.ends_with('}') && token.len() > 2 {
        let inner = &token[1..token.len() - 1];
        if inner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b':' || b == b'-')
        {
            return true;
        }
    }
    // Bare braces and brace fragments
    if token == "{" || token == "}" || token == "\u{2581}{" {
        return true;
    }
    false
}

fn build_special_token_ids(tokens: &[String]) -> HashSet<usize> {
    let mut ids = HashSet::new();
    for (i, token) in tokens.iter().enumerate() {
        if is_special_token(token) {
            ids.insert(i);
        }
    }
    ids
}

fn extract_mel_features(
    samples: &[f32],
    filterbank: &[f64],
    hann_window: &[f64],
    fft_plan: &dyn RealToComplex<f64>,
) -> (Vec<f32>, usize) {
    let audio_len = if samples.len() < FRAME_LEN {
        FRAME_LEN
    } else {
        samples.len()
    };

    let frames = (audio_len - FRAME_LEN) / HOP_LEN + 1;
    let mut features = vec![0.0f32; frames * N_MELS];
    let bins = N_FFT / 2 + 1;

    let mut scratch = fft_plan.make_scratch_vec();
    let mut input_buf = fft_plan.make_input_vec();
    let mut output_buf = fft_plan.make_output_vec();

    for frame_idx in 0..frames {
        let offset = frame_idx * HOP_LEN;

        // Zero-fill input buffer
        for v in input_buf.iter_mut() {
            *v = 0.0;
        }

        // Apply window
        for s in 0..FRAME_LEN {
            let sample = if offset + s < samples.len() {
                samples[offset + s] as f64
            } else {
                0.0
            };
            input_buf[s] = sample * hann_window[s];
        }

        // FFT
        fft_plan
            .process_with_scratch(&mut input_buf, &mut output_buf, &mut scratch)
            .expect("FFT failed");

        // Compute mel features from complex FFT output
        for mel_idx in 0..N_MELS {
            let mut sum = 0.0f64;
            for bin in 0..bins {
                let c = output_buf[bin];
                let power = c.re * c.re + c.im * c.im;
                sum += power * filterbank[bin * N_MELS + mel_idx];
            }
            features[frame_idx * N_MELS + mel_idx] = sum.max(1e-5).ln() as f32;
        }
    }

    (features, frames)
}

fn decode_ctc(logits: &[f32], frames: usize, vocab_size: usize, vocab: &AsrVocab) -> String {
    let mut result = Vec::new();
    let mut prev_token: isize = -1;

    for frame_idx in 0..frames {
        let offset = frame_idx * vocab_size;
        let mut best_idx: usize = 0;
        let mut best_val = logits[offset];

        for tok_idx in 1..vocab_size {
            let score = logits[offset + tok_idx];
            if score > best_val {
                best_val = score;
                best_idx = tok_idx;
            }
        }

        if best_idx != vocab.blank_id && best_idx as isize != prev_token {
            if best_idx != vocab.eos_id && !vocab.special_ids.contains(&best_idx) {
                if let Some(token) = vocab.tokens.get(best_idx) {
                    result.push(token.as_str());
                }
            }
        }
        prev_token = best_idx as isize;
    }

    result.join("").replace('\u{2581}', " ").trim().to_string()
}

fn normalize_section_headers(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some(close_offset) = text[i + 1..].find(']') {
                let inner = &text[i + 1..i + 1 + close_offset];
                if !inner.is_empty()
                    && inner
                        .chars()
                        .all(|ch| ch.is_ascii_uppercase() || ch == ' ' || ch == '-')
                    && inner.chars().any(|ch| ch.is_ascii_uppercase())
                {
                    // Sentence-case the header
                    let mut first = true;
                    for ch in inner.chars() {
                        if first && ch.is_ascii_uppercase() {
                            result.push(ch);
                            first = false;
                        } else {
                            result.push(ch.to_ascii_lowercase());
                        }
                    }
                    // Move past ']'
                    i += 1 + close_offset + 1;
                    // Skip whitespace, then lowercase the next letter
                    let mut added_space = false;
                    while i < bytes.len() && bytes[i] == b' ' {
                        if !added_space {
                            result.push(' ');
                            added_space = true;
                        }
                        i += 1;
                    }
                    if i < bytes.len() && bytes[i].is_ascii_uppercase() {
                        result.push((bytes[i] as char).to_ascii_lowercase());
                        i += 1;
                    }
                    continue;
                }
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }

    result
}

fn strip_leading_bracket_artifact(text: &str) -> String {
    let original = text.trim();
    if !original.starts_with('[') {
        return original.to_string();
    }

    if let Some(close_idx) = original.find(']') {
        if close_idx <= 24 {
            return original.to_string();
        }
    }

    let stripped = original.trim_start_matches('[').trim_start();
    if stripped.is_empty() {
        original.to_string()
    } else {
        stripped.to_string()
    }
}

pub fn load_ctc_session(model_path: &str, vocab_path: &str) -> Result<RunningAsr, String> {
    // Load vocab
    let vocab_bytes = std::fs::read(vocab_path)
        .map_err(|e| format!("Failed to read vocab file {vocab_path}: {e}"))?;
    let vocab_json: VocabJson = serde_json::from_slice(&vocab_bytes)
        .map_err(|e| format!("Failed to parse vocab JSON: {e}"))?;

    let special_ids = build_special_token_ids(&vocab_json.tokens);
    let vocab = AsrVocab {
        blank_id: vocab_json.blank_id.unwrap_or(0),
        eos_id: vocab_json.eos_token_id.unwrap_or(usize::MAX),
        special_ids,
        tokens: vocab_json.tokens,
    };

    // Load ONNX model
    let session = ort::session::Session::builder()
        .map_err(|e| format!("Failed to create session builder: {e}"))?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
        .map_err(|e| format!("Failed to set optimization level: {e}"))?
        .commit_from_file(model_path)
        .map_err(|e| format!("Failed to load ONNX model {model_path}: {e}"))?;

    let mel_filterbank = build_mel_filterbank();
    let hann_window = build_hann_window();

    let mut planner = RealFftPlanner::<f64>::new();
    let fft_plan = planner.plan_fft_forward(N_FFT);

    Ok(RunningAsr::Ctc(Arc::new(CtcSession {
        session: Mutex::new(session),
        vocab,
        mel_filterbank,
        hann_window,
        fft_plan,
    })))
}

pub(super) fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

pub fn load_whisper_session(
    model_path: &str,
    runtime_config: WhisperRuntimeConfig,
) -> Result<RunningAsr, String> {
    let mut context_params = WhisperContextParameters::default();
    context_params.use_gpu = false;

    let context = WhisperContext::new_with_params(model_path, context_params)
        .map_err(|e| format!("Failed to load Whisper model {model_path}: {e}"))?;
    let state = context
        .create_state()
        .map_err(|e| {
            format!("Failed to load Whisper model {model_path}: failed to create state: {e}")
        })?;

    let runtime_config = WhisperRuntimeConfig {
        language: normalize_optional_text(runtime_config.language),
        translate: runtime_config.translate,
        initial_prompt: normalize_optional_text(runtime_config.initial_prompt),
    };

    Ok(RunningAsr::Whisper(Arc::new(WhisperSession {
        _context: context,
        state: Mutex::new(state),
        runtime_config,
    })))
}

pub fn transcribe(asr: &RunningAsr, samples: &[f32]) -> Result<RuntimeExecuteResult, String> {
    match asr {
        RunningAsr::Ctc(session) => transcribe_ctc(session, samples),
        RunningAsr::Whisper(session) => transcribe_whisper(session, samples),
    }
}

fn transcribe_ctc(asr: &CtcSession, samples: &[f32]) -> Result<RuntimeExecuteResult, String> {
    let (features, frames) = extract_mel_features(
        samples,
        &asr.mel_filterbank,
        &asr.hann_window,
        asr.fft_plan.as_ref(),
    );

    // Build input tensors using (shape, data) tuples
    let input_features = Tensor::from_array(([1i64, frames as i64, N_MELS as i64], features))
        .map_err(|e| format!("Failed to create input tensor: {e}"))?;

    let mask_data = vec![true; frames];
    let attention_mask = Tensor::from_array(([1i64, frames as i64], mask_data))
        .map_err(|e| format!("Failed to create attention mask: {e}"))?;

    let mut session = asr
        .session
        .lock()
        .map_err(|e| format!("Failed to lock ASR session: {e}"))?;

    let outputs = session
        .run(ort::inputs![
            "input_features" => input_features,
            "attention_mask" => attention_mask,
        ])
        .map_err(|e| format!("ONNX inference failed: {e}"))?;

    // Get logits from output (try "logits" key first, fall back to first output)
    let logits_value = if outputs.contains_key("logits") {
        &outputs["logits"]
    } else {
        &outputs[0]
    };

    let (shape, logits_slice): (&ort::tensor::Shape, &[f32]) = logits_value
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("Failed to extract logits: {e}"))?;

    if shape.len() != 3 {
        return Err(format!("Unexpected logits shape: {shape:?}"));
    }

    let time_frames = shape[1] as usize;
    let vocab_size = shape[2] as usize;

    let text = decode_ctc(logits_slice, time_frames, vocab_size, &asr.vocab);
    let text = normalize_section_headers(&text);
    let text = strip_leading_bracket_artifact(&text);

    Ok(RuntimeExecuteResult { text })
}

fn transcribe_whisper(
    asr: &WhisperSession,
    samples: &[f32],
) -> Result<RuntimeExecuteResult, String> {
    let mut state = asr
        .state
        .lock()
        .map_err(|e| format!("Failed to lock Whisper session: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 3,
        patience: -1.0, // whisper.cpp default
    });
    params.set_language(asr.runtime_config.language.as_deref());
    params.set_translate(asr.runtime_config.translate);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    params.set_suppress_non_speech_tokens(true);
    params.set_no_speech_thold(0.2);
    if let Some(initial_prompt) = asr.runtime_config.initial_prompt.as_deref() {
        params.set_initial_prompt(initial_prompt);
    }

    state
        .full(params, samples)
        .map_err(|e| format!("Whisper inference failed: {e}"))?;

    let segment_count = state
        .full_n_segments()
        .map_err(|e| format!("Whisper inference failed: {e}"))?;
    let mut full_text = String::new();
    for segment_idx in 0..segment_count {
        let segment_text = state
            .full_get_segment_text_lossy(segment_idx)
            .map_err(|e| format!("Whisper inference failed: {e}"))?;
        full_text.push_str(&segment_text);
    }

    Ok(RuntimeExecuteResult {
        text: full_text.trim().to_string(),
    })
}

pub(super) fn unload(running: &mut HashMap<String, RunningAsr>, plugin_id: &str) {
    running.remove(plugin_id);
}
