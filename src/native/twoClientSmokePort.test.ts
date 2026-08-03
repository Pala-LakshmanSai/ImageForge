import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { createTwoClientSmokePort } from './twoClientSmokePort';

describe('two-client installed smoke port', () => {
  beforeEach(() => invoke.mockReset());

  it('fails closed when a fixture barrier does not release successfully', async () => {
    invoke.mockResolvedValue({
      status: 408,
      body: { error: { code: 'checkpoint_timeout', message: 'Peer missing', details: null } },
    });

    await expect(createTwoClientSmokePort('A').checkpoint('startup'))
      .rejects.toThrow('rejected checkpoint startup');
  });

  it('requires the final audit to report an explicit pass', async () => {
    invoke.mockResolvedValue({ status: 200, body: { passed: false } });

    await expect(createTwoClientSmokePort('B').audit())
      .rejects.toThrow('rejected the final audit');
  });

  it('maps only exact RunPod paths and rejects an arbitrary renderer URL', async () => {
    invoke.mockResolvedValue({ status: 200, body: [] });
    const { port } = createTwoClientSmokePort('A');

    await expect(port.runPodFetch('https://api.runpod.io/graphql/pods')).resolves.toBeInstanceOf(Response);
    expect(invoke).toHaveBeenCalledWith('native_two_client_smoke_exchange', {
      input: { operation: 'runpod_list' },
    });
    await expect(port.runPodFetch('https://example.com/secrets')).rejects.toThrow(
      'rejected an unexpected RunPod path',
    );
  });

  it('allows owner artifact acknowledgements but forbids remote artifact transfer', async () => {
    invoke.mockResolvedValue({
      status: 200,
      body: {
        schemaVersion: 1,
        batchId: '11111111-1111-4111-8111-111111111111',
        index: 1,
        filename: 'batches/Two-client installed smoke/000001.jpg',
        sha256: 'a'.repeat(64),
        sizeBytes: 4097,
        verifiedAtUnixMs: 1,
      },
    });
    const input = {
      batchId: '11111111-1111-4111-8111-111111111111',
      batchName: 'Two-client installed smoke',
      index: 1,
      expectedSha256: 'a'.repeat(64),
      expectedSizeBytes: 4097,
      expectedWidth: 1280,
      expectedHeight: 720,
    };

    await expect(createTwoClientSmokePort('A').port.downloadArtifact(input))
      .resolves.toMatchObject({ index: 1, sizeBytes: 4097 });
    await expect(createTwoClientSmokePort('B').port.downloadArtifact(input))
      .rejects.toThrow('must never download owner artifacts');
  });
});
