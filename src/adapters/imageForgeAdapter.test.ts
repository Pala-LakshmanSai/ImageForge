import { describe, expect, it } from 'vitest';
import { DEFAULT_STUDIO_PROFILE, parseStudioProfile } from './imageForgeAdapter';

describe('studio profile parser', () => {
  it('accepts the fixed EU-RO-1 ImageForge contract', () => {
    expect(parseStudioProfile(DEFAULT_STUDIO_PROFILE)).toEqual({
      profile: 'imageforge-studio-v1',
      templateId: 'imageforge-worker-v1',
      networkVolumeId: 'if-models-production',
      dataCenter: 'EU-RO-1',
      gpuPolicy: 'eu-ro-1-approved-v1',
      workerPort: 8000,
      modelPreset: 'flux2-klein-bf16',
    });
  });

  it('rejects duplicate, unknown, wrong-region, and URL-shaped values', () => {
    const mutations = [
      `${DEFAULT_STUDIO_PROFILE}\ntemplate_id: duplicate`,
      `${DEFAULT_STUDIO_PROFILE}\nsecret: should-not-be-here`,
      DEFAULT_STUDIO_PROFILE.replace('EU-RO-1', 'US-CA-2'),
      DEFAULT_STUDIO_PROFILE.replace('imageforge-worker-v1', 'https://evil.example/template'),
      DEFAULT_STUDIO_PROFILE.replace('worker_port: 8000', 'worker_port: 22'),
    ];
    for (const source of mutations) expect(parseStudioProfile(source)).toBeNull();
  });
});
