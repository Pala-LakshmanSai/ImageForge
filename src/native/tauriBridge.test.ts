import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as bridgeExports from './tauriBridge';
import {
  NATIVE_RUNPOD_API_KEY_SENTINEL,
  asNativeError,
  isNativeDesktop,
  nativeWorkerStudioCancelStopRequest,
  nativeWorkerStudioCreateStopRequest,
  nativeWorkerStudioFinalizeStopRequest,
  nativeWorkerStudioHeartbeat,
  nativeWorkerStudioRespondToStopRequest,
  nativeWorkerStudioStatus,
} from './tauriBridge';

const invokeMock = vi.hoisted(() => vi.fn(async () => ({ status: 200, body: {} })));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

beforeEach(() => invokeMock.mockClear());

describe('native bridge safety boundary', () => {
  it('does not treat a normal browser test runtime as native', () => {
    expect(isNativeDesktop()).toBe(false);
  });

  it('normalizes unknown failures without reflecting raw values', () => {
    const secret = 'rp_secret_should_not_escape';
    const normalized = asNativeError(new Error(secret));
    expect(normalized.message).not.toContain(secret);
    expect(JSON.stringify(normalized)).not.toContain(secret);
  });

  it('uses a non-credential sentinel for the JS RunPod transport', () => {
    expect(NATIVE_RUNPOD_API_KEY_SENTINEL).toBe('__IMAGEFORGE_NATIVE_VAULT__');
    expect(NATIVE_RUNPOD_API_KEY_SENTINEL).not.toMatch(/^rp_/);
  });

  it('sends only the six named studio command payloads and carries the exact Pod on finalization', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const requestId = '55555555-5555-4555-8555-555555555555';
    const finalizationId = '66666666-6666-4666-8666-666666666666';

    await nativeWorkerStudioHeartbeat(sessionId, 'foreground');
    await nativeWorkerStudioStatus(sessionId);
    await nativeWorkerStudioCreateStopRequest(requestId, sessionId, 'shared-pod-1', 'RTX 4090');
    await nativeWorkerStudioRespondToStopRequest(requestId, sessionId, 'approve');
    await nativeWorkerStudioFinalizeStopRequest(
      requestId,
      sessionId,
      'shared-pod-1',
      finalizationId,
    );
    await nativeWorkerStudioCancelStopRequest(
      requestId,
      sessionId,
      'shared-pod-1',
      finalizationId,
    );

    expect(invokeMock.mock.calls).toEqual([
      ['worker_studio_heartbeat', { input: { sessionId, availability: 'foreground' } }],
      ['worker_studio_status', { sessionId }],
      ['worker_studio_create_stop_request', {
        input: { requestId, sessionId, podId: 'shared-pod-1', gpuDisplayName: 'RTX 4090' },
      }],
      ['worker_studio_respond_to_stop_request', {
        input: { requestId, sessionId, decision: 'approve' },
      }],
      ['worker_studio_finalize_stop_request', {
        input: { requestId, sessionId, podId: 'shared-pod-1', finalizationId },
      }],
      ['worker_studio_cancel_stop_request', {
        input: { requestId, sessionId, podId: 'shared-pod-1', finalizationId },
      }],
    ]);
    expect(
      Object.keys(bridgeExports)
        .filter((name) => name.startsWith('nativeWorkerStudio'))
        .sort(),
    ).toEqual([
      'nativeWorkerStudioCancelStopRequest',
      'nativeWorkerStudioCreateStopRequest',
      'nativeWorkerStudioFinalizeStopRequest',
      'nativeWorkerStudioHeartbeat',
      'nativeWorkerStudioRespondToStopRequest',
      'nativeWorkerStudioStatus',
    ]);
  });
});
