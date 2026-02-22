# Language Selection (Japanese / English)

**Date:** 2026-02-22
**Status:** Ready for planning

## What We're Building

A language setting that lets users switch Dr. Toru between English and Japanese.
This affects two layers:

1. **UI labels** -- all hard-coded English strings (buttons, headers, status
   messages, SOAP/transcript labels) become translatable via a `t()` helper
   backed by a simple TypeScript key-value map.

2. **LLM prompts** -- when Japanese is selected, the Rust-side prompt templates
   for SOAP generation, treatment summaries, and transcript cleanup are replaced
   with native Japanese equivalents. SOAP headers use the dual format:
   `S（主観的所見）/ O（客観的所見）/ A（評価）/ P（計画）`.

**Out of scope:** ASR language. Which language the speech recogniser expects is
determined by the imported ASR plugin/model, not this setting.

## Why This Approach

- **Simple key-value map in TypeScript** -- a single `src/i18n.ts` module with
  a `Record<Language, Record<string, string>>`. No external libraries, no JSON
  file I/O, no build-time extraction. Easy to grep for missing keys.

- **Native-language LLM prompt templates in Rust** -- rather than prepending
  "respond in Japanese" to English prompts (fragile with smaller models), we
  maintain parallel prompt strings in `llamafile.rs`. Two languages is a small
  maintenance surface.

- **`toru.language` in localStorage** -- follows the existing settings pattern
  (`toru.*` keys). Default: `"en"`.

## Key Decisions

- **Scope: LLM output + full UI translation.** Not just clinical output --
  buttons, headers, and status messages are all translated.
- **ASR is a separate concern.** The language setting does not change ASR
  behaviour; that's plugin-dependent.
- **SOAP headers use dual format** when Japanese is selected:
  `S（主観的所見）` rather than pure Japanese or pure English abbreviations.
- **Simple TS map over JSON files.** For two languages, a single module is
  simpler and sufficient. Can migrate to JSON later if more locales are added.
- **Native Japanese prompt templates** in Rust for best LLM output quality.

## Open Questions

- Should the language dropdown trigger an immediate reload (like ASR settings
  do today), or can it apply without a reload?
- Are there any clinical terms that should remain in English even in Japanese
  mode (e.g., drug names, ICD codes)?
