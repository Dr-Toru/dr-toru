import { createUlid } from "./ulid";

export const SESSION_FORMAT = 1 as const;

export type ArtifactRole = "source" | "derived";
export type ArtifactCreator = "asr" | "transform" | "user" | "system";
export type ArtifactMetaValue = string | number | boolean | null;
export type ArtifactKind = "transcript_raw" | "transcript_corrected" | "audio_capture";
export type TextArtifactKind = Extract<ArtifactKind, "transcript_raw" | "transcript_corrected">;

export interface ArtifactRecord {
  artifactId: string;
  kind: ArtifactKind;
  role: ArtifactRole;
  contentType: string;
  path: string;
  createdAt: string;
  createdBy: ArtifactCreator;
  sourceArtifactId: string | null;
  metadata: Record<string, ArtifactMetaValue>;
}

export interface SessionRecord {
  format: typeof SESSION_FORMAT;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  activeArtifactId: string | null;
  artifacts: ArtifactRecord[];
}

export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  activeArtifactId: string | null;
  artifactCount: number;
}

export interface NewSessionInput {
  sessionId?: string;
  createdAt?: string;
}

export interface NewTextArtifactInput {
  artifactId?: string;
  kind: TextArtifactKind;
  role: ArtifactRole;
  createdAt?: string;
  createdBy: ArtifactCreator;
  path: string;
  sourceArtifactId?: string | null;
  metadata?: Record<string, ArtifactMetaValue>;
}

export function createSession(input: NewSessionInput = {}): SessionRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    format: SESSION_FORMAT,
    sessionId: input.sessionId ?? createUlid(),
    createdAt,
    updatedAt: createdAt,
    activeArtifactId: null,
    artifacts: [],
  };
}

export function createTextArtifact(input: NewTextArtifactInput): ArtifactRecord {
  return {
    artifactId: input.artifactId ?? createUlid(),
    kind: input.kind,
    role: input.role,
    contentType: "text/plain",
    path: input.path,
    createdAt: input.createdAt ?? new Date().toISOString(),
    createdBy: input.createdBy,
    sourceArtifactId: input.sourceArtifactId ?? null,
    metadata: input.metadata ?? {},
  };
}
