import {
  R6_LOCK_PATH,
  R6_MIRROR_PATH,
  TAX04_LOCK_PATH,
  TAX04_MIRROR_PATH,
} from './baseline.constants.js';
import { verifyMirror } from './baseline.integrity.js';
import {
  buildManifest,
  manifestSha256,
} from './baseline.manifest.js';
import { parseR6 } from './baseline.parser.js';
import type {
  BaselineIntermediateModel,
  BaselineManifest,
  VerifiedSource,
} from './baseline.types.js';
import { assertValidManifest } from './baseline.validator.js';

export interface LoadedBaseline {
  source: VerifiedSource;
  technicalContract: VerifiedSource;
  model: BaselineIntermediateModel;
  manifest: BaselineManifest;
  manifestSha256: string;
}

export async function loadBaseline(): Promise<LoadedBaseline> {
  const [source, technicalContract] = await Promise.all([
    verifyMirror(R6_MIRROR_PATH, R6_LOCK_PATH),
    verifyMirror(TAX04_MIRROR_PATH, TAX04_LOCK_PATH),
  ]);

  const model = parseR6(source.text);
  const manifest = buildManifest(
    model,
    source,
    technicalContract,
  );

  assertValidManifest(manifest);

  return {
    source,
    technicalContract,
    model,
    manifest,
    manifestSha256: manifestSha256(manifest),
  };
}
