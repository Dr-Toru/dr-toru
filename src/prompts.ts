import { getLanguage, type Language } from "./i18n";

const prompts: Record<Language, Record<string, string>> = {
  en: {
    soap: [
      "Convert the following clinical note into SOAP format.",
      "",
      "Use these section headers exactly:",
      "SUBJECTIVE:",
      "OBJECTIVE:",
      "ASSESSMENT:",
      "PLAN:",
      "",
      "Keep medical terminology accurate. ",
      'If information for a section is not available, write "Not documented." ',
      "Be concise but thorough. ",
      "Output only the SOAP note with no additional commentary or critique.",
    ].join("\n"),

    treatment_summary: [
      "Convert the following clinical note into a treatment summary letter.",
      "",
      "Write a professional clinical letter with these sections in order:",
      "",
      '1. GREETING: Begin with "To whom it may concern,"',
      "2. PATIENT RELATIONSHIP: State how the patient is known to the author ",
      '(e.g. "This patient has been followed at our clinic since...", ',
      '"This patient presented to our clinic on...").',
      "3. CLINICAL PROBLEM AND NEEDS: Describe the clinical problem and ",
      "what is being requested (e.g. additional examinations, specialist opinion, ",
      "continued management).",
      "4. MEDICATION AND TREATMENT NOTES: Note relevant medications, treatments ",
      'given or not given and why (e.g. "The patient declined X" or ',
      '"X was not prescribed due to...").',
      "5. CLOSING: End with a polite professional closing ",
      '(e.g. "Thank you for your kind attention to this patient. ',
      'Please do not hesitate to contact us if you require further information.").',
      "",
      "Keep medical terminology accurate. ",
      "Write in a professional, concise tone. ",
      'Do not invent a recipient name -- use "Dear Colleague" only. ',
      "Output only the letter with no additional commentary or critique.",
    ].join("\n"),

    default:
      "Correct grammar and punctuation while preserving clinical meaning.",
  },
  ja: {
    soap: [
      "以下の臨床記録をSOAP形式に変換してください。",
      "",
      "以下のセクション見出しを正確に使用してください：",
      "S（主観的所見）:",
      "O（客観的所見）:",
      "A（評価）:",
      "P（計画）:",
      "",
      "医学用語を正確に使用してください。",
      "該当する情報がないセクションには「記載なし」と記入してください。",
      "簡潔かつ網羅的に記述してください。",
      "SOAPノートのみを出力し、追加の解説や批評は含めないでください。",
      "すべて日本語で記述してください。",
    ].join("\n"),

    treatment_summary: [
      "以下の臨床記録から、治療経過についての自由記載を日本語で作成してください。",
      "",
      "以下の構成で記述してください：",
      "",
      "1. 患者との関係：「当院通院中の患者です」または「当院初診の患者です」など。",
      "2. 臨床的問題：現在の問題点、主訴、経過を記述してください。",
      "3. 投薬・治療に関する記録：関連する投薬、実施または未実施の治療と",
      "その理由を記述してください",
      "（例：「〇〇の薬は希望されないため投与しておりません」）。",
      "4. 今後の方針：検査予定、紹介、経過観察などを記述してください。",
      "",
      "医学用語を正確に使用してください。",
      "専門的で簡潔な文体で記述してください。",
      "本文のみを出力し、追加の解説や批評は含めないでください。",
    ].join("\n"),

    default:
      "文法と句読点を修正し、臨床的な意味を保持してください。すべて日本語で記述してください。",
  },
};

export function getLlmPrompt(action: string): string {
  const lang = getLanguage();
  return prompts[lang][action] ?? prompts[lang].default ?? prompts.en.default;
}
