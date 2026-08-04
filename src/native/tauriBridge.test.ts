import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as bridgeExports from './tauriBridge';
import {
  asNativeError,
  isNativeDesktop,
  nativeQueueAcquireRunner,
  nativeQueuePrepareDispatch,
  nativeQueueReleaseSmokeExchange,
  nativeQueueSetSleepPrevention,
  nativeQueueSignalAlert,
  parseQueueReleaseSmokeEvidence,
  queueReleaseSmokeP95,
  nativeWorkerStudioCancelStopRequest,
  nativeWorkerStudioCreateStopRequest,
  nativeWorkerStudioHeartbeat,
  nativeWorkerStudioRespondToGpuSwitch,
  nativeWorkerStudioRespondToStopRequest,
  nativeWorkerStudioStatus,
} from './tauriBridge';

function queueReleaseEvidence() {
  const runRevision = '33333333-3333-4333-8333-333333333333';
  const samplesMs = Array.from({ length: 30 }, (_, index) => index + 1);
  return {
    schemaVersion: 1,
    smokeId: '44444444-4444-4444-8444-444444444444',
    platform: 'macos',
    architecture: 'aarch64',
    appVersion: '0.1.9',
    completedAt: '2026-08-03T12:00:00.000Z',
    viewport: { width: 1440, height: 900, horizontalOverflowPx: 0 },
    queue: {
      requestedRows: 450,
      maxMountedRows: 12,
      visibleRowLimit: 40,
      realNativeBridge: true,
      runRevision,
      runnerLeaseReleased: true,
      batches: [1, 2, 3].map((ordinal) => ({
        ordinal,
        queueItemId: `00000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`,
        clientSubmissionId: `00000000-0000-4000-9000-${ordinal.toString().padStart(12, '0')}`,
        remoteBatchId: `00000000-0000-4000-a000-${ordinal.toString().padStart(12, '0')}`,
        promptCount: 1,
        preparedWithNativeBridge: true,
        receiptCount: 1,
        receiptFixedPoint: true,
        terminalState: 'completed',
        minimizedAtCompletion: true,
      })),
    },
    prompts: { requestedRows: 450, maxMountedRows: 15, visibleRowLimit: 30 },
    keyboard: {
      sampleCount: 30,
      trustedSampleCount: 30,
      key: 'Enter',
      operation: 'move',
      samplesMs,
      p95Ms: queueReleaseSmokeP95(samplesMs),
    },
    minimized: { observed: true, sequentialBatches: 3 },
    alarm: {
      eventId: `queue-complete:${runRevision}`,
      signalCalls: 1,
      uniqueEvents: 1,
      fixedPoint: true,
      disposition: 'delivered',
    },
    runPod: { createCalls: 0, deleteCalls: 0 },
  };
}

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

  it('strictly validates every queue command response before it reaches React', async () => {
    const queueItemId = '11111111-1111-4111-8111-111111111111';
    const clientSubmissionId = '22222222-2222-4222-8222-222222222222';
    const runRevision = '33333333-3333-4333-8333-333333333333';
    const eventId = `queue-complete:${runRevision}`;

    invokeMock.mockResolvedValueOnce({
      queueItemId,
      clientSubmissionId,
      name: 'Safe batch',
      prompts: ['One prompt'],
      baseSeed: 100_000,
      destination: '/safe/output',
      aspectRatio: '16:9',
      references: [],
      unexpected: true,
    } as never);
    await expect(nativeQueuePrepareDispatch({ queueItemId, clientSubmissionId, purpose: 'dispatch' }))
      .rejects.toThrow(/schema/i);

    invokeMock.mockResolvedValueOnce({ runRevision, held: true, unexpected: true } as never);
    await expect(nativeQueueAcquireRunner({ runRevision })).rejects.toThrow(/schema/i);

    invokeMock.mockResolvedValueOnce({
      runRevision: null,
      active: true,
      platform: 'macos',
      displaySleepAllowed: true,
    } as never);
    await expect(nativeQueueSetSleepPrevention({ runRevision, enabled: true })).rejects.toThrow(/invalid/i);

    invokeMock.mockResolvedValueOnce({ eventId, notificationId: 0, disposition: 'delivered' } as never);
    await expect(nativeQueueSignalAlert({ eventId, kind: 'complete' })).rejects.toThrow(/invalid/i);
  });

  it('validates queue release evidence, raw samples, and the strict smoke-only exchange', async () => {
    const evidence = parseQueueReleaseSmokeEvidence(queueReleaseEvidence());
    expect(evidence.keyboard.samplesMs).toHaveLength(30);
    expect(evidence.keyboard.p95Ms).toBe(29);

    expect(() => parseQueueReleaseSmokeEvidence({
      ...queueReleaseEvidence(),
      keyboard: { ...queueReleaseEvidence().keyboard, p95Ms: 1 },
    })).toThrow(/invalid/i);
    expect(() => parseQueueReleaseSmokeEvidence({
      ...queueReleaseEvidence(),
      unexpected: true,
    })).toThrow(/schema/i);
    expect(() => parseQueueReleaseSmokeEvidence({
      ...queueReleaseEvidence(),
      queue: { ...queueReleaseEvidence().queue, maxMountedRows: 0 },
    })).toThrow(/invalid/i);

    invokeMock.mockResolvedValueOnce({
      schemaVersion: 1,
      operation: 'bootstrap',
      platform: 'windows',
      architecture: 'x86_64',
      appVersion: '0.1.9',
      destination: 'C:\\queue-release-output',
    } as never);
    await expect(nativeQueueReleaseSmokeExchange({ schemaVersion: 1, operation: 'bootstrap' }))
      .resolves.toMatchObject({ operation: 'bootstrap', platform: 'windows' });

    invokeMock.mockResolvedValueOnce({
      schemaVersion: 1,
      operation: 'bootstrap',
      platform: 'windows',
      architecture: 'x86_64',
      appVersion: '0.1.9',
      destination: '\\\\?\\C:\\queue-release-output',
    } as never);
    await expect(nativeQueueReleaseSmokeExchange({ schemaVersion: 1, operation: 'bootstrap' }))
      .resolves.toMatchObject({ destination: '\\\\?\\C:\\queue-release-output' });

    invokeMock.mockResolvedValueOnce({
      schemaVersion: 1,
      operation: 'bootstrap',
      platform: 'windows',
      architecture: 'x86_64',
      appVersion: '0.1.9',
      destination: '\\\\?\\UNC\\server\\share',
    } as never);
    await expect(nativeQueueReleaseSmokeExchange({ schemaVersion: 1, operation: 'bootstrap' }))
      .rejects.toThrow(/invalid/i);

    invokeMock.mockResolvedValueOnce({
      schemaVersion: 1,
      operation: 'write_evidence',
      written: true,
      evidenceSha256: 'a'.repeat(64),
    } as never);
    await nativeQueueReleaseSmokeExchange({ schemaVersion: 1, operation: 'write_evidence', evidence });
    expect(invokeMock).toHaveBeenLastCalledWith('native_queue_release_smoke_exchange', {
      input: { schemaVersion: 1, operation: 'write_evidence', evidence },
    });

    await expect(nativeQueueReleaseSmokeExchange({
      schemaVersion: 1,
      operation: 'dispatch_trusted_key',
      sampleIndex: 31,
      key: 'Enter',
    })).rejects.toThrow(/request is invalid/i);
  });

  it('exposes only the six renderer-safe studio command payloads', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const requestId = '55555555-5555-4555-8555-555555555555';
    const finalizationId = '66666666-6666-4666-8666-666666666666';

    await nativeWorkerStudioHeartbeat(sessionId, 'foreground');
    await nativeWorkerStudioStatus(sessionId);
    await nativeWorkerStudioCreateStopRequest(requestId, sessionId, 'shared-pod-1', 'RTX 4090');
    await nativeWorkerStudioRespondToStopRequest(requestId, sessionId, 'approve');
    await nativeWorkerStudioRespondToGpuSwitch(requestId, sessionId, 'deny');
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
      ['worker_studio_respond_to_gpu_switch', {
        input: { switchId: requestId, sessionId, decision: 'deny' },
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
      'nativeWorkerStudioHeartbeat',
      'nativeWorkerStudioRespondToGpuSwitch',
      'nativeWorkerStudioRespondToStopRequest',
      'nativeWorkerStudioStatus',
    ]);
  });
});
