---
title: "feat: Language Selection (Japanese / English)"
type: feat
date: 2026-02-22
---

# feat: Language Selection (Japanese / English)

## Overview

Add a language setting that switches Dr. Toru between English and Japanese.
The setting affects two layers: all user-facing UI strings (via a `t()` helper),
and LLM prompt templates (native Japanese equivalents in Rust). ASR language
is out of scope — it depends on the imported plugin/model.

Brainstorm: `docs/brainstorms/2026-02-22-language-selection-brainstorm.md`

## Architectural Decisions

These decisions resolve the open questions surfaced during spec analysis.

1. **Prompt propagation: frontend constructs prompt, passes via existing
   `prompt` parameter (Option A).** This keeps Rust changes minimal, allows
   web-only dev testing, and uses the already-supported `prompt` parameter
   on `runLlm()`. Prompt templates live in TypeScript alongside the i18n
   module.

2. **Static HTML translation: `data-i18n` attributes + DOM sweep.** A
   `translateDom()` function iterates elements with `data-i18n` and sets
   `textContent`, `placeholder`, and `aria-label` from the translation map.
   This is the lightest approach that doesn't require converting static HTML
   to JS-rendered text.

3. **LLM output language is coupled to UI language.** A single
   `toru.language` setting controls both. Decoupling can be added later if
   needed.

4. **Interpolation in `t()`.** The function accepts an optional params
   object: `t("attachmentCount", { count: 3 })`. Translation values use
   `{count}` placeholders. This handles pluralisation differences (English
   needs plural suffixes, Japanese does not).

5. **Language provenance on attachments.** When saving LLM-generated text,
   store `{ language: "ja" }` (or `"en"`) in attachment metadata.

6. **Immediate effect, no reload.** Language change triggers `translateDom()`
   and updates module-level language variable. No page reload required.

7. **Default: `"en"`.** No auto-detection for now. Can be added later.

8. **`<html lang>` and `toLocaleString` follow app language.** Set
   `document.documentElement.lang` on change. Pass `toru.language` locale
   to all `toLocaleString` calls.

9. **Translate user-workflow strings. Leave error messages in English for
   v1.** Navigation, buttons, labels, headers, placeholders, blank states
   are all translated. Error messages and developer-facing strings stay
   English.

## Proposed Solution

### Phase 1: i18n Module (`src/i18n.ts`)

Create a single module that owns language state and provides the `t()` function.

```typescript
// src/i18n.ts

export type Language = "en" | "ja";

const STORAGE_KEY = "toru.language";
const DEFAULT_LANGUAGE: Language = "en";

// Module-level state
let currentLanguage: Language = readLanguage();

export function getLanguage(): Language {
  return currentLanguage;
}

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  translateDom();
}

export function readLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "ja") return stored;
  return DEFAULT_LANGUAGE;
}

export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  const map = translations[currentLanguage];
  let value = map[key] ?? translations.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(`{${k}}`, String(v));
    }
  }
  return value;
}

// DOM sweep for static HTML elements with data-i18n attributes
export function translateDom(): void {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n")!;
    el.textContent = t(key);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder")!;
    (el as HTMLInputElement).placeholder = t(key);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria")!;
    el.setAttribute("aria-label", t(key));
  });
}
```

**Translation map** lives in the same file (or a sibling `src/i18n-strings.ts`
if it grows large). Structure:

```typescript
const translations: Record<Language, Record<string, string>> = {
  en: {
    sessions: "Sessions",
    newSession: "New Session",
    settings: "Settings",
    plugins: "Plugins",
    transcript: "Transcript",
    context: "Context",
    soapNote: "SOAP Note",
    summary: "Summary",
    generate: "Generate",
    regenerate: "Regenerate",
    copy: "Copy",
    copied: "Copied",
    save: "Save",
    delete: "Delete",
    listening: "Listening",
    loading: "Loading",
    searchPlaceholder: "Search transcripts",
    noSessions: "No sessions yet",
    noSessionsHint: "Open a new session to get started",
    noMatches: "No matching sessions",
    noMatchesHint: "Try another search phrase",
    attachmentCount: "{count} attachment{plural}",
    matchCount: "{count} match{plural}",
    generateSoap: "Generate a SOAP note from your transcript",
    generatingSoap: "Generating SOAP note...",
    generateSummary: "Generate a treatment summary from your transcript",
    generatingSummary: "Generating treatment summary...",
    importPlugin: "Import Plugin",
    textGeneration: "Text Generation",
    dictation: "Dictation",
    builtIn: "Built-in",
    transcriptStarted: "Transcript started",
    transcriptStopped: "Transcript stopped",
    clinicalNotes: "Clinical Notes",
    enhancedDictation: "Enhanced Dictation",
    enabled: "Enabled",
    language: "Language",
    // ...remaining strings
  },
  ja: {
    sessions: "セッション",
    newSession: "新規セッション",
    settings: "設定",
    plugins: "プラグイン",
    transcript: "文字起こし",
    context: "コンテキスト",
    soapNote: "SOAPノート",
    summary: "サマリー",
    generate: "生成",
    regenerate: "再生成",
    copy: "コピー",
    copied: "コピーしました",
    save: "保存",
    delete: "削除",
    listening: "聴取中",
    loading: "読み込み中",
    searchPlaceholder: "文字起こしを検索",
    noSessions: "セッションはありません",
    noSessionsHint: "新規セッションを開始してください",
    noMatches: "該当するセッションがありません",
    noMatchesHint: "別の検索語をお試しください",
    attachmentCount: "{count} 添付ファイル",
    matchCount: "{count} 件一致",
    generateSoap: "文字起こしからSOAPノートを生成",
    generatingSoap: "SOAPノート生成中...",
    generateSummary: "文字起こしから治療サマリーを生成",
    generatingSummary: "治療サマリー生成中...",
    importPlugin: "プラグインをインポート",
    textGeneration: "テキスト生成",
    dictation: "ディクテーション",
    builtIn: "内蔵",
    transcriptStarted: "文字起こし開始",
    transcriptStopped: "文字起こし終了",
    clinicalNotes: "臨床ノート",
    enhancedDictation: "拡張ディクテーション",
    enabled: "有効",
    language: "言語",
    // ...remaining strings
  },
};
```

**Files to create:**

- `src/i18n.ts` — language state, `t()`, `translateDom()`, translation maps

### Phase 2: LLM Prompt Templates in TypeScript

Move prompt template selection to the frontend so language can be applied
without Rust changes. Create a `src/prompts.ts` module.

```typescript
// src/prompts.ts
import { getLanguage, type Language } from "./i18n";

const prompts: Record<Language, Record<string, string>> = {
  en: {
    soap: `Convert the following clinical note into SOAP format...
Use exactly these section headers:
SUBJECTIVE:
OBJECTIVE:
ASSESSMENT:
PLAN:
...`,
    treatment_summary: `Write a professional clinical letter...`,
    default: `Correct grammar and punctuation while preserving clinical meaning.`,
  },
  ja: {
    soap: `以下の臨床記録をSOAP形式に変換してください。
以下のセクション見出しを正確に使用してください：
S（主観的所見）:
O（客観的所見）:
A（評価）:
P（計画）:
記載がないセクションには「記載なし」と記入してください。
医学用語を正確に使用してください。すべて日本語で記述してください。`,
    treatment_summary: `以下の臨床記録から、専門的な治療サマリーレターを日本語で作成してください。
以下のセクションを含めてください：
1. 挨拶
2. 患者との関係
3. 臨床的問題
4. 投薬・治療内容
5. 結語
...`,
    default: `文法と句読点を修正し、臨床的な意味を保持してください。すべて日本語で記述してください。`,
  },
};

export function getLlmPrompt(action: string): string {
  const lang = getLanguage();
  return prompts[lang][action] ?? prompts[lang].default ?? prompts.en.default;
}
```

**Integration point:** `recording-view-controller.ts` calls
`platform.runLlm("soap", input)` → change to
`platform.runLlm("soap", input, getLlmPrompt("soap"))`.

The Rust-side `default_llamafile_prompt()` becomes a fallback only reached
when no `prompt` is passed (backwards compatible, no Rust changes needed).

**Files to create:**

- `src/prompts.ts` — language-aware prompt templates

**Files to modify:**

- `src/app/recording-view-controller.ts` — pass `getLlmPrompt(action)` to `runLlm()`

### Phase 3: HTML `data-i18n` Annotations

Add `data-i18n` attributes to translatable elements in `index.html`.

Example changes:

```html
<!-- Before -->
<h1 class="view-title">Sessions</h1>

<!-- After -->
<h1 class="view-title" data-i18n="sessions">Sessions</h1>
```

```html
<!-- Before -->
<input
  type="search"
  placeholder="Search transcripts"
  aria-label="Search transcripts"
/>

<!-- After -->
<input
  type="search"
  placeholder="Search transcripts"
  data-i18n-placeholder="searchPlaceholder"
  aria-label="Search transcripts"
  data-i18n-aria="searchPlaceholder"
/>
```

The English text remains in the HTML as the default/fallback. The `data-i18n`
attribute keys into the translation map. `translateDom()` overwrites on
language change.

**Key elements to annotate in `index.html`:**

| Line(s) | Element                           | Key                      |
| ------- | --------------------------------- | ------------------------ |
| 38      | `<h1>Sessions</h1>`               | `sessions`               |
| 66      | search input placeholder + aria   | `searchPlaceholder`      |
| 88-89   | "New Session" FAB                 | `newSession`             |
| 119     | `<span id="subviewTitleLabel">`   | (dynamic, handled in TS) |
| 140     | "Transcript" dropdown item        | `transcript`             |
| 149-153 | "SOAP Note" dropdown item         | `soapNote`               |
| 155-159 | "Summary" dropdown item           | `summary`                |
| 211     | "Listening" span                  | `listening`              |
| 287     | "Clinical Notes" heading          | `clinicalNotes`          |
| 306     | "SOAP Note" heading               | `soapNote`               |
| 322     | SOAP blank-state text             | `generateSoap`           |
| 334     | "Generate" button                 | `generate`               |
| 339     | "Generating SOAP note..."         | `generatingSoap`         |
| 365     | Summary blank-state text          | `generateSummary`        |
| 377     | "Generate" button                 | `generate`               |
| 382     | "Generating treatment summary..." | `generatingSummary`      |
| 408     | `<h2>Settings</h2>`               | `settings`               |
| 411     | `<h3>Plugins</h3>`                | `plugins`                |
| 525     | "Save" button                     | `save`                   |
| 530     | "Import Plugin" button            | `importPlugin`           |

**Files to modify:**

- `index.html` — add `data-i18n`, `data-i18n-placeholder`, `data-i18n-aria` attributes

### Phase 4: TypeScript String Replacement

Replace hard-coded English strings in TypeScript with `t()` calls.

**`src/app/recording-view-controller.ts`:**

- Line 16-21: `SUBVIEW_LABELS` → make dynamic: `function getSubviewLabels() { return { transcript: t("transcript"), ... }; }`
- Lines 668, 674: `"Regenerate"` / `"Generate"` → `t("regenerate")` / `t("generate")`
- Lines 507, 523: `"Transcript started"` / `"Transcript stopped"` → `t("transcriptStarted")` / `t("transcriptStopped")`
- Lines 500, 516: `toLocaleString(undefined, ...)` → `toLocaleString(getLanguage(), ...)`

**`src/main.ts`:**

- Lines 204-252: `"Copied"` / `"Copy"` → `t("copied")` / `t("copy")`
- Lines 504-507: `"Text Generation"` / `"Dictation"` → `t("textGeneration")` / `t("dictation")`
- Line 558: `"No plugins imported yet."` → `t("noPluginsYet")`
- Line 589: `"Built-in"` → `t("builtIn")`

**`src/app/list/index.ts`:**

- Lines 215-216: attachment count pluralisation → `t("attachmentCount", { count: n })`
- Lines 223: match count → `t("matchCount", { count: n })`
- Line 459-460: empty state text → `t("noSessions")`, `t("noSessionsHint")`
- Line 113-114: no matches text → `t("noMatches")`, `t("noMatchesHint")`

**`src/app/asr-settings-controller.ts`:**

- Line 78: status text → `t("dictationTuneHint")`
- Line 84: stop recording warning → `t("stopRecordingBeforeSave")`
- Line 109: save confirmation → `t("dictationSettingsSaved")`

**Files to modify:**

- `src/app/recording-view-controller.ts`
- `src/main.ts`
- `src/app/list/index.ts`
- `src/app/asr-settings-controller.ts`

### Phase 5: Settings UI

Add a language dropdown to the settings screen, placed above the "Plugins"
section.

**HTML addition in `index.html` (settings screen, before Plugins heading):**

```html
<h3 data-i18n="language">Language</h3>
<div class="settings-grid">
  <label class="setting-field">
    <select id="languageSelect">
      <option value="en">English</option>
      <option value="ja">日本語</option>
    </select>
  </label>
</div>
```

Note: dropdown option labels are intentionally in their own language
(English / 日本語) so they are readable regardless of current setting.

**Controller integration in `src/main.ts`:**

```typescript
import { readLanguage, setLanguage } from "./i18n";

// In DOMContentLoaded handler:
const languageSelect = document.getElementById(
  "languageSelect",
) as HTMLSelectElement;
languageSelect.value = readLanguage();
languageSelect.addEventListener("change", () => {
  setLanguage(languageSelect.value as Language);
});
```

No separate controller class needed — language is a single dropdown with
immediate effect. Wire it directly in `main.ts`.

**Files to modify:**

- `index.html` — add language dropdown to settings section
- `src/main.ts` — wire dropdown to `setLanguage()`

### Phase 6: Attachment Language Provenance

When saving LLM-generated text, record the language in attachment metadata.

**In `recording-view-controller.ts`**, where `saveAttachmentText` is called
after LLM generation:

```typescript
metadata: {
  ...existingMetadata,
  language: getLanguage(),
}
```

This is a low-cost addition using the existing schemaless `metadata` field
on `Attachment`. No domain type changes needed.

**Files to modify:**

- `src/app/recording-view-controller.ts` — add `language` to attachment metadata on save

### Phase 7: Initialization

On app startup (`src/main.ts`, DOMContentLoaded):

1. Read language: `readLanguage()` → sets module state
2. Set `document.documentElement.lang`
3. Call `translateDom()` for initial sweep
4. Populate language dropdown

```typescript
import { readLanguage, setLanguage, translateDom } from "./i18n";

// Early in DOMContentLoaded:
const lang = readLanguage();
document.documentElement.lang = lang;
translateDom();
```

**Files to modify:**

- `src/main.ts` — add initialization calls

## Acceptance Criteria

- [x] Language dropdown appears in Settings, above Plugins section
- [x] Selecting "日本語" immediately switches all UI labels to Japanese
- [x] Selecting "English" switches back — no reload required
- [x] SOAP generation in Japanese mode produces Japanese output with dual
      headers: `S（主観的所見）`, `O（客観的所見）`, `A（評価）`, `P（計画）`
- [x] Treatment summary generation in Japanese mode produces Japanese output
- [x] Language persists across app restarts (localStorage `toru.language`)
- [x] `<html lang>` attribute updates on language change
- [x] Date/time formatting uses the app language locale
- [x] LLM-generated attachments include `language` in metadata
- [x] Default language is English when no setting exists
- [x] Existing English SOAP notes display correctly after switching to Japanese
- [x] Prompt templates use natural Japanese (not literal translations)

## File Change Summary

| Action | File                                   | Purpose                                                    |
| ------ | -------------------------------------- | ---------------------------------------------------------- |
| Create | `src/i18n.ts`                          | Language state, `t()`, `translateDom()`, string maps       |
| Create | `src/prompts.ts`                       | Language-aware LLM prompt templates                        |
| Modify | `index.html`                           | `data-i18n` attributes, language dropdown in settings      |
| Modify | `src/main.ts`                          | Init i18n, wire language dropdown                          |
| Modify | `src/app/recording-view-controller.ts` | `t()` calls, pass prompts to `runLlm()`, language metadata |
| Modify | `src/app/list/index.ts`                | `t()` calls for list view strings                          |
| Modify | `src/app/asr-settings-controller.ts`   | `t()` calls for settings strings                           |

No Rust changes required. The existing `prompt` parameter on the Tauri
command handles language-specific prompts passed from the frontend.
