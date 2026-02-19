//! ASR benchmark using the native Rust ORT code path.
//!
//! Tests greedy CTC decoding at various chunk sizes with and without
//! stride-overlap merging (same algorithm as dictation-controller.ts).
//!
//! Usage:
//!   cd src-tauri
//!   cargo run --release --bin benchmark-asr
//!   cargo run --release --bin benchmark-asr -- --audio ../benchmarks/test.wav --reference ../benchmarks/test.txt

use std::time::Instant;

use dr_toru_lib::plugins::asr;

const SAMPLE_RATE: f64 = 16000.0;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

struct Args {
    audio_path: String,
    reference: String,
    model_path: String,
    vocab_path: String,
}

fn parse_args() -> Args {
    let args: Vec<String> = std::env::args().collect();
    let mut audio_path = String::new();
    let mut reference = String::new();
    let mut model_path = String::new();
    let mut vocab_path = String::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--audio" if i + 1 < args.len() => {
                i += 1;
                audio_path = args[i].clone();
            }
            "--reference" if i + 1 < args.len() => {
                i += 1;
                reference = args[i].clone();
            }
            "--model" if i + 1 < args.len() => {
                i += 1;
                model_path = args[i].clone();
            }
            "--vocab" if i + 1 < args.len() => {
                i += 1;
                vocab_path = args[i].clone();
            }
            _ => {}
        }
        i += 1;
    }

    if audio_path.is_empty() {
        audio_path = "../benchmarks/test.wav".to_string();
    }
    if reference.is_empty() {
        let ref_path = "../benchmarks/test.txt";
        if let Ok(text) = std::fs::read_to_string(ref_path) {
            reference = text.trim().to_string();
        }
    }
    if model_path.is_empty() {
        model_path = "../public/models/medasr_lasr_ctc_int8.onnx".to_string();
    }
    if vocab_path.is_empty() {
        vocab_path = "../public/models/medasr_lasr_vocab.json".to_string();
    }

    if audio_path.is_empty() || reference.is_empty() {
        eprintln!("Usage: benchmark-asr [--audio <wav>] [--reference <text|file>] [--model <onnx>] [--vocab <json>]");
        std::process::exit(1);
    }

    Args {
        audio_path,
        reference,
        model_path,
        vocab_path,
    }
}

// ---------------------------------------------------------------------------
// WAV decoding (16-bit PCM, 16kHz mono)
// ---------------------------------------------------------------------------

fn decode_wav(path: &str) -> Vec<f32> {
    let data = std::fs::read(path).unwrap_or_else(|e| {
        eprintln!("Failed to read WAV file {path}: {e}");
        std::process::exit(1);
    });

    if data.len() < 44 {
        eprintln!("WAV file too small");
        std::process::exit(1);
    }

    let riff = &data[0..4];
    let wave = &data[8..12];
    if riff != b"RIFF" || wave != b"WAVE" {
        eprintln!("Not a valid WAV file");
        std::process::exit(1);
    }

    let mut offset = 12usize;
    let mut audio_format: u16 = 0;
    let mut num_channels: u16 = 0;
    let mut sample_rate: u32 = 0;
    let mut bits_per_sample: u16 = 0;

    while offset + 8 <= data.len() {
        let chunk_id = &data[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            data[offset + 4],
            data[offset + 5],
            data[offset + 6],
            data[offset + 7],
        ]) as usize;

        if chunk_id == b"fmt " && offset + 24 <= data.len() {
            audio_format = u16::from_le_bytes([data[offset + 8], data[offset + 9]]);
            num_channels = u16::from_le_bytes([data[offset + 10], data[offset + 11]]);
            sample_rate = u32::from_le_bytes([
                data[offset + 12],
                data[offset + 13],
                data[offset + 14],
                data[offset + 15],
            ]);
            bits_per_sample = u16::from_le_bytes([data[offset + 22], data[offset + 23]]);
        } else if chunk_id == b"data" {
            if audio_format != 1 {
                eprintln!("Unsupported audio format {audio_format} (need PCM=1)");
                std::process::exit(1);
            }
            if bits_per_sample != 16 {
                eprintln!("Unsupported bits per sample {bits_per_sample} (need 16)");
                std::process::exit(1);
            }
            if sample_rate != 16000 {
                eprintln!("Warning: WAV sample rate is {sample_rate}Hz, expected 16000Hz");
            }

            let data_offset = offset + 8;
            let bytes_per_sample = (bits_per_sample / 8) as usize;
            let total_samples = chunk_size / (bytes_per_sample * num_channels as usize);
            let mut samples = Vec::with_capacity(total_samples);

            for i in 0..total_samples {
                let pos = data_offset + i * num_channels as usize * bytes_per_sample;
                if pos + 1 >= data.len() {
                    break;
                }
                let int16 = i16::from_le_bytes([data[pos], data[pos + 1]]);
                samples.push(int16 as f32 / 32768.0);
            }

            return samples;
        }

        offset += 8 + chunk_size;
        if chunk_size % 2 != 0 {
            offset += 1;
        }
    }

    eprintln!("No data chunk found in WAV file");
    std::process::exit(1);
}

// ---------------------------------------------------------------------------
// Chunking with configurable stride
// ---------------------------------------------------------------------------

fn chunk_audio<'a>(audio: &'a [f32], chunk_secs: f64, stride_secs: f64) -> Vec<&'a [f32]> {
    let chunk_len = (chunk_secs * SAMPLE_RATE) as usize;
    if chunk_len >= audio.len() {
        return vec![audio];
    }
    let stride_len = (stride_secs * SAMPLE_RATE) as usize;
    let step_len = chunk_len - stride_len;
    let mut chunks = Vec::new();
    let mut offset = 0;
    while offset < audio.len() {
        let end = (offset + chunk_len).min(audio.len());
        chunks.push(&audio[offset..end]);
        if end >= audio.len() {
            break;
        }
        offset += step_len;
    }
    chunks
}

// ---------------------------------------------------------------------------
// Overlap merging (ported from dictation-controller.ts)
// ---------------------------------------------------------------------------

const MAX_WORD_OVERLAP: usize = 20;
const MIN_SINGLE_TOKEN_OVERLAP_LEN: usize = 2;
const SHORT_STRIDE_WORD_LEN: usize = 3;
const MAX_CHAR_OVERLAP: usize = 24;
const MIN_CHAR_OVERLAP: usize = 4;

fn normalize_merge_token(token: &str) -> String {
    token
        .to_lowercase()
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '_')
        .trim()
        .to_string()
}

fn find_word_overlap(current_words: &[&str], next_words: &[&str]) -> usize {
    let max_overlap = current_words
        .len()
        .min(next_words.len())
        .min(MAX_WORD_OVERLAP);

    for size in (1..=max_overlap).rev() {
        let mut matched = true;
        for idx in 0..size {
            let left = normalize_merge_token(current_words[current_words.len() - size + idx]);
            let right = normalize_merge_token(next_words[idx]);
            if left.is_empty() || right.is_empty() || left != right {
                matched = false;
                break;
            }
        }
        if !matched {
            continue;
        }
        if size == 1 {
            let token = normalize_merge_token(current_words[current_words.len() - 1]);
            if token.len() < MIN_SINGLE_TOKEN_OVERLAP_LEN {
                return 0;
            }
        }
        return size;
    }
    0
}

fn find_char_overlap(current_text: &str, next_text: &str) -> usize {
    let left = current_text.to_lowercase();
    let right = next_text.to_lowercase();
    let max_size = left.len().min(right.len()).min(MAX_CHAR_OVERLAP);

    for size in (MIN_CHAR_OVERLAP..=max_size).rev() {
        let tail = &left[left.len() - size..];
        let head = &right[..size];
        if tail != head {
            continue;
        }
        if !head.chars().any(|c| c.is_alphanumeric()) {
            continue;
        }
        return size;
    }
    0
}

fn merge_chunk_text(current_text: &str, next_text: &str) -> String {
    let next = next_text.trim();
    if next.is_empty() {
        return current_text.to_string();
    }
    if current_text.is_empty() {
        return next.to_string();
    }

    let current_words: Vec<&str> = current_text.split_whitespace().collect();
    let next_words: Vec<&str> = next.split_whitespace().collect();
    let overlap_count = find_word_overlap(&current_words, &next_words);

    if overlap_count > 0 {
        let suffix: String = next_words[overlap_count..].join(" ");
        if suffix.is_empty() {
            return current_text.to_string();
        }
        if overlap_count == 1
            && normalize_merge_token(next_words[0]).len() <= SHORT_STRIDE_WORD_LEN
        {
            return format!("{current_text} {suffix}");
        }
        return if current_text.is_empty() {
            suffix
        } else {
            format!("{current_text}\n{suffix}")
        };
    }

    // Rejected short-token overlap: keep both inline
    let last_word = normalize_merge_token(current_words[current_words.len() - 1]);
    let first_word = normalize_merge_token(next_words[0]);
    if !last_word.is_empty()
        && !first_word.is_empty()
        && last_word == first_word
        && last_word.len() < MIN_SINGLE_TOKEN_OVERLAP_LEN
    {
        return format!("{current_text} {next}");
    }

    let char_overlap = find_char_overlap(current_text, next);
    if char_overlap > 0 {
        let suffix = next[char_overlap..].trim_start();
        return if suffix.is_empty() {
            current_text.to_string()
        } else {
            format!("{current_text}{suffix}")
        };
    }

    if current_text.is_empty() {
        next.to_string()
    } else {
        format!("{current_text}\n{next}")
    }
}

// ---------------------------------------------------------------------------
// WER (word error rate, MedASR normalization)
// ---------------------------------------------------------------------------

fn normalize_for_wer(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let cleaned = lower.replace("</s>", "");
    let normalized: String = cleaned
        .chars()
        .map(|c| {
            if c == ' ' || c.is_ascii_alphanumeric() || c == '\'' {
                c
            } else {
                ' '
            }
        })
        .collect();
    normalized
        .split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

fn compute_wer(reference: &str, hypothesis: &str) -> f64 {
    let ref_words = normalize_for_wer(reference);
    let hyp_words = normalize_for_wer(hypothesis);

    if ref_words.is_empty() {
        return if hyp_words.is_empty() { 0.0 } else { 1.0 };
    }

    let n = ref_words.len();
    let m = hyp_words.len();
    let mut dp = vec![vec![0usize; m + 1]; n + 1];

    for i in 0..=n {
        dp[i][0] = i;
    }
    for j in 0..=m {
        dp[0][j] = j;
    }

    for i in 1..=n {
        for j in 1..=m {
            let cost = if ref_words[i - 1] == hyp_words[j - 1] {
                0
            } else {
                1
            };
            dp[i][j] = (dp[i - 1][j] + 1)
                .min(dp[i][j - 1] + 1)
                .min(dp[i - 1][j - 1] + cost);
        }
    }

    dp[n][m] as f64 / n as f64
}

// ---------------------------------------------------------------------------
// Table printing
// ---------------------------------------------------------------------------

struct BenchResult {
    label: String,
    chunk_label: String,
    wer: f64,
    time_secs: f64,
    transcript: String,
}

fn truncate(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        s.to_string()
    } else {
        let end = max_chars.saturating_sub(3);
        let prefix: String = chars[..end].iter().collect();
        format!("{prefix}...")
    }
}

fn repeat_char(c: char, n: usize) -> String {
    std::iter::repeat(c).take(n).collect()
}

fn print_table(results: &[BenchResult]) {
    let lw = 16;
    let cw = 8;
    let ww = 7;
    let tw = 9;
    let trw = 48;

    let h = repeat_char('─', lw);
    let hc = repeat_char('─', cw);
    let hw = repeat_char('─', ww);
    let ht = repeat_char('─', tw);
    let htr = repeat_char('─', trw);

    println!("┌{h}┬{hc}┬{hw}┬{ht}┬{htr}┐");
    println!(
        "│{:<lw$}│{:>cw$}│{:>ww$}│{:>tw$}│{:<trw$}│",
        "Config", "Chunks", "WER", "Time (s)", "Transcript",
    );
    println!("├{h}┼{hc}┼{hw}┼{ht}┼{htr}┤");

    for r in results {
        let tr = truncate(&r.transcript.replace('\n', " "), trw);
        println!(
            "│{:<lw$}│{:>cw$}│{:>ww$}│{:>tw$}│{:<trw$}│",
            r.label,
            r.chunk_label,
            format!("{:.1}%", r.wer * 100.0),
            format!("{:.1}", r.time_secs),
            tr,
        );
    }

    println!("└{h}┴{hc}┴{hw}┴{ht}┴{htr}┘");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let cli = parse_args();

    println!("ASR Benchmark (native Rust ORT)");
    println!("===============================");
    println!("Audio: {}", cli.audio_path);
    println!(
        "Reference: \"{}\"",
        truncate(&cli.reference, 60)
    );
    println!();

    // Load audio
    println!("Loading audio...");
    let audio = decode_wav(&cli.audio_path);
    let duration_secs = audio.len() as f64 / SAMPLE_RATE;
    println!(
        "  {} samples, {:.1}s at {:.0}Hz",
        audio.len(),
        duration_secs,
        SAMPLE_RATE
    );

    // Load ASR model
    println!("Model: {}", cli.model_path);
    println!("Loading ASR model...");
    let running = asr::load_session(&cli.model_path, &cli.vocab_path).unwrap_or_else(|e| {
        eprintln!("Failed to load ASR: {e}");
        std::process::exit(1);
    });
    let session = &running.0;
    println!("  Model loaded");
    println!();

    // Chunk configs: (chunk_secs, stride_secs)
    let chunk_configs: Vec<(f64, f64)> = vec![
        (6.0, 1.5),   // app default
        (10.0, 2.0),
        (15.0, 1.5),
        (20.0, 2.0),
        (30.0, 3.0),
    ];

    println!("Running benchmarks...");
    println!();

    let mut results = Vec::new();

    // Full audio (no chunking)
    {
        print!("  {:<28}", "full");
        let start = Instant::now();
        let transcript = match asr::transcribe(session, &audio) {
            Ok(r) => r.text.trim().to_string(),
            Err(e) => {
                eprintln!("\nTranscription error: {e}");
                std::process::exit(1);
            }
        };
        let elapsed = start.elapsed().as_secs_f64();
        let wer = compute_wer(&cli.reference, &transcript);
        println!("WER={:.1}%  time={:.1}s", wer * 100.0, elapsed);
        results.push(BenchResult {
            label: "full".to_string(),
            chunk_label: "1".to_string(),
            wer,
            time_secs: elapsed,
            transcript,
        });
    }

    // Chunked configs with both merge strategies
    for (chunk_secs, stride_secs) in &chunk_configs {
        let chunks = chunk_audio(&audio, *chunk_secs, *stride_secs);
        let n_chunks = chunks.len();
        let chunk_label = format!("{:.0}s/{:.1}s", chunk_secs, stride_secs);

        // Transcribe all chunks once
        let mut chunk_texts = Vec::new();
        let start = Instant::now();
        for chunk in &chunks {
            match asr::transcribe(session, chunk) {
                Ok(r) => chunk_texts.push(r.text.trim().to_string()),
                Err(e) => {
                    eprintln!("\nTranscription error: {e}");
                    std::process::exit(1);
                }
            }
        }
        let elapsed = start.elapsed().as_secs_f64();

        // Simple concatenation
        let concat_transcript = chunk_texts
            .iter()
            .filter(|t| !t.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        let concat_wer = compute_wer(&cli.reference, &concat_transcript);

        let concat_label = format!("{chunk_label} concat");
        print!("  {:<28}", concat_label);
        println!(
            "WER={:.1}%  time={:.1}s  chunks={}",
            concat_wer * 100.0,
            elapsed,
            n_chunks
        );

        results.push(BenchResult {
            label: concat_label,
            chunk_label: n_chunks.to_string(),
            wer: concat_wer,
            time_secs: elapsed,
            transcript: concat_transcript,
        });

        // Overlap merging
        let mut merged_transcript = String::new();
        for text in &chunk_texts {
            merged_transcript = merge_chunk_text(&merged_transcript, text);
        }
        let merge_wer = compute_wer(&cli.reference, &merged_transcript);

        let merge_label = format!("{chunk_label} merge");
        print!("  {:<28}", merge_label);
        println!("WER={:.1}%", merge_wer * 100.0);

        results.push(BenchResult {
            label: merge_label,
            chunk_label: n_chunks.to_string(),
            wer: merge_wer,
            time_secs: elapsed,
            transcript: merged_transcript,
        });
    }

    println!();
    print_table(&results);

    // Print full transcripts
    println!();
    println!("Full transcripts:");
    println!("{}", "─".repeat(70));
    for r in &results {
        println!("[{}]", r.label);
        println!("{}", r.transcript);
        println!();
    }

    // Best result
    if let Some(best) = results
        .iter()
        .min_by(|a, b| a.wer.partial_cmp(&b.wer).unwrap())
    {
        println!(
            "Best: {} — WER={:.1}%",
            best.label,
            best.wer * 100.0
        );
    }
}
