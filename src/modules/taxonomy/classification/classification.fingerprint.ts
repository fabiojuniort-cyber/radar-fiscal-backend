import {
  canonicalJson,
  sha256Hex,
} from '../baseline/baseline.canonical-json.js';

export type ClassificationMethodType =
  | 'RULE'
  | 'EXTRACTOR'
  | 'MODEL'
  | 'HUMAN'
  | 'HYBRID';

export interface ClassificationFingerprintInput {
  publicationVersionId: string;
  taxonomyReleaseId: string;
  methodType: ClassificationMethodType;
  engineKey: string;
  engineVersion: string;
  modelKey?: string | null;
  modelVersion?: string | null;
  codeGitSha?: string | null;
  configSnapshot: Record<string, unknown>;
  inputSha256: string;
}

export interface ClassificationFingerprint {
  configCanonicalJson: string;
  configSha256: string;
  runFingerprint: string;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(field + ' must not be blank');
  }
  return normalized;
}

function optional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  return normalized || null;
}

function sha256(value: string, field: string): string {
  const normalized = required(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(field + ' must be a lowercase SHA-256 hex string');
  }
  return normalized;
}

export function buildClassificationFingerprint(
  input: ClassificationFingerprintInput,
): ClassificationFingerprint {
  const modelKey = optional(input.modelKey);
  const modelVersion = optional(input.modelVersion);

  if ((modelKey === null) !== (modelVersion === null)) {
    throw new Error('modelKey and modelVersion must be supplied together');
  }

  if (input.methodType === 'MODEL' && modelKey === null) {
    throw new Error('MODEL classification requires modelKey and modelVersion');
  }

  const configCanonicalJson = canonicalJson(input.configSnapshot);
  const configSha256 = sha256Hex(configCanonicalJson);

  const material = [
    required(input.publicationVersionId, 'publicationVersionId'),
    required(input.taxonomyReleaseId, 'taxonomyReleaseId'),
    input.methodType,
    required(input.engineKey, 'engineKey'),
    required(input.engineVersion, 'engineVersion'),
    modelKey,
    modelVersion,
    optional(input.codeGitSha),
    configSha256,
    sha256(input.inputSha256, 'inputSha256'),
  ];

  return {
    configCanonicalJson,
    configSha256,
    runFingerprint: sha256Hex(canonicalJson(material)),
  };
}
