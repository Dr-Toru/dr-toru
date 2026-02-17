export interface ArtifactTemplate {
  type: string;
  title: string;
  description: string;
  systemPrompt: string;
}

export const ARTIFACT_TEMPLATES: ArtifactTemplate[] = [
  {
    type: "soap",
    title: "SOAP Note",
    description: "Structured clinical note with S/O/A/P sections",
    systemPrompt:
      "You are a medical scribe. Convert the following clinical dictation into a structured SOAP note.\n\nFormat with these exact section headers:\nSUBJECTIVE:\nOBJECTIVE:\nASSESSMENT:\nPLAN:\n\nBe concise. Use clinical language. Do not add information not present in the dictation.",
  },
  {
    type: "progress",
    title: "Progress Note",
    description: "Follow-up visit documentation",
    systemPrompt:
      "You are a medical scribe. Convert the following clinical dictation into a progress note documenting a follow-up visit.\n\nInclude: chief complaint, interval history, current medications, examination findings, assessment, and plan.\n\nBe concise. Use clinical language. Do not add information not present in the dictation.",
  },
  {
    type: "referral",
    title: "Referral Letter",
    description: "Professional letter to a specialist",
    systemPrompt:
      "You are a medical scribe. Convert the following clinical dictation into a professional referral letter to a specialist.\n\nInclude: reason for referral, relevant history, current findings, and specific questions for the specialist.\n\nUse formal letter format. Be concise. Do not add information not present in the dictation.",
  },
];

export function findTemplate(type: string): ArtifactTemplate | undefined {
  return ARTIFACT_TEMPLATES.find((t) => t.type === type);
}
