export type Language = "en" | "ja";

const STORAGE_KEY = "toru.language";
const DEFAULT_LANGUAGE: Language = "en";

let currentLanguage: Language = readLanguage();

export function getLanguage(): Language {
  return currentLanguage;
}

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Best-effort persist
  }
  document.documentElement.lang = lang;
  translateDom();
}

export function readLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "ja") return stored;
  } catch {
    // localStorage may be unavailable
  }
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
      value = value.split(`{${k}}`).join(String(v));
    }
  }
  return value;
}

export function translateDom(): void {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.getAttribute("data-i18n")!;
    el.textContent = t(key);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    const key = el.getAttribute("data-i18n-placeholder")!;
    (el as HTMLInputElement).placeholder = t(key);
  }
  for (const el of document.querySelectorAll("[data-i18n-aria]")) {
    const key = el.getAttribute("data-i18n-aria")!;
    el.setAttribute("aria-label", t(key));
  }
}

const translations: Record<Language, Record<string, string>> = {
  en: {
    // List view
    sessions: "Sessions",
    newSession: "New Session",
    searchPlaceholder: "Search transcripts",
    noSessions: "No sessions yet",
    noSessionsHint: "Open a new session to get started",
    noMatches: "No matching sessions",
    noMatchesHint: "Try another search phrase",
    attachmentCount: "{count} attachment{plural}",
    matchCount: "{count} match{plural}",

    // Recording view - subview labels
    transcript: "Transcript",
    context: "Context",
    soapNote: "SOAP Note",
    summary: "Summary",
    treatmentSummary: "Treatment Summary",

    // Recording view - actions
    copy: "Copy",
    copied: "Copied",
    generate: "Generate",
    regenerate: "Regenerate",
    upload: "Upload",
    transcribe: "Transcribe",
    loading: "Loading",

    // Recording view - blank states
    transcriptBlankState:
      "Start recording or upload an audio file to generate a transcript",
    generateSoap: "Generate a SOAP note from your transcript",
    generatingSoap: "Generating SOAP note...",
    generateSummary: "Generate a treatment summary from your transcript",
    generatingSummary: "Generating treatment summary...",

    // Recording view - timestamps
    transcriptStarted: "Transcript started",
    transcriptStopped: "Transcript stopped",
    listening: "Listening",

    // Context sub-view
    clinicalNotes: "Clinical Notes",
    contextPlaceholder:
      "Add any additional context about the patient or paste files here",

    // Settings view
    settings: "Settings",
    language: "Language",
    plugins: "Plugins",
    enhancedDictation: "Enhanced Dictation",
    enabled: "Enabled",
    save: "Save",
    importPlugin: "Import Plugin",
    noPluginsYet: "No plugins imported yet.",
    textGeneration: "Text Generation",
    dictation: "Dictation",
    builtIn: "Built-in",
    delete: "Delete",
    export: "Export",
    advancedDictationTuning: "Advanced dictation tuning",
    dictationTuneHint:
      "Tune dictation behavior here. Saving reloads the app and applies updates.",
    stopRecordingBeforeSave: "Stop recording before saving dictation settings.",
    dictationSettingsSaved:
      "Dictation settings saved. Reloading to apply updates...",

    // Dismiss
    dismiss: "Dismiss",
  },
  ja: {
    // List view
    sessions: "セッション",
    newSession: "新規セッション",
    searchPlaceholder: "文字起こしを検索",
    noSessions: "セッションはありません",
    noSessionsHint: "新規セッションを開始してください",
    noMatches: "該当するセッションがありません",
    noMatchesHint: "別の検索語をお試しください",
    attachmentCount: "{count} 添付ファイル",
    matchCount: "{count} 件一致",

    // Recording view - subview labels
    transcript: "文字起こし",
    context: "コンテキスト",
    soapNote: "SOAPノート",
    summary: "サマリー",
    treatmentSummary: "治療サマリー",

    // Recording view - actions
    copy: "コピー",
    copied: "コピーしました",
    generate: "生成",
    regenerate: "再生成",
    upload: "アップロード",
    transcribe: "文字起こし",
    loading: "読み込み中",

    // Recording view - blank states
    transcriptBlankState:
      "録音を開始するか音声ファイルをアップロードして文字起こしを生成",
    generateSoap: "文字起こしからSOAPノートを生成",
    generatingSoap: "SOAPノート生成中...",
    generateSummary: "文字起こしから治療サマリーを生成",
    generatingSummary: "治療サマリー生成中...",

    // Recording view - timestamps
    transcriptStarted: "文字起こし開始",
    transcriptStopped: "文字起こし終了",
    listening: "聴取中",

    // Context sub-view
    clinicalNotes: "臨床ノート",
    contextPlaceholder:
      "患者に関する追加情報やファイルをここに貼り付けてください",

    // Settings view
    settings: "設定",
    language: "言語",
    plugins: "プラグイン",
    enhancedDictation: "拡張ディクテーション",
    enabled: "有効",
    save: "保存",
    importPlugin: "プラグインをインポート",
    noPluginsYet: "インポートされたプラグインはありません。",
    textGeneration: "テキスト生成",
    dictation: "ディクテーション",
    builtIn: "内蔵",
    delete: "削除",
    export: "エクスポート",
    advancedDictationTuning: "詳細ディクテーション設定",
    dictationTuneHint:
      "ディクテーション動作を調整します。保存するとアプリが再読み込みされます。",
    stopRecordingBeforeSave:
      "ディクテーション設定を保存する前に録音を停止してください。",
    dictationSettingsSaved:
      "ディクテーション設定を保存しました。更新を適用するため再読み込み中...",

    // Dismiss
    dismiss: "閉じる",
  },
};
