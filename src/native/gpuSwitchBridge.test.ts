import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  nativeGpuSwitchAcquire,
  nativeGpuSwitchAuthorizeForeground,
  nativeGpuSwitchBegin,
  nativeGpuSwitchCancel,
  nativeGpuSwitchComplete,
  nativeGpuSwitchConfirmActualPrice,
  nativeGpuSwitchConfirmAttempt,
  nativeGpuSwitchConfirmTarget,
  nativeGpuSwitchCreateReplacement,
  nativeGpuSwitchDeleteOld,
  nativeGpuSwitchDeleteReplacement,
  nativeGpuSwitchFinalize,
  nativeGpuSwitchLoad,
  nativeGpuSwitchPrepareAttempt,
  nativeGpuSwitchReconcileProvider,
  nativeGpuSwitchRelease,
  nativeGpuSwitchSyncWorker,
  nativeGpuSwitchVerifyReplacement,
  parseNativeGpuSwitchSnapshotV1,
  type NativeGpuSwitchSnapshotV1,
} from './gpuSwitchBridge';

const IDS = {
  switchId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  observationId: '33333333-3333-4333-8333-333333333333',
  receiptId: '44444444-4444-4444-8444-444444444444',
  sessionId: '55555555-5555-4555-8555-555555555555',
  grantId: '66666666-6666-4666-8666-666666666666',
  epochId: '77777777-7777-4777-8777-777777777777',
  quoteId: '88888888-8888-4888-8888-888888888888',
  queueRunRevision: '99999999-9999-4999-8999-999999999999',
} as const;

function snapshot(): NativeGpuSwitchSnapshotV1 {
  const target = {
    replacementAttemptId: IDS.attemptId,
    attemptRevision: 1,
    gpuId: 'NVIDIA GeForce RTX 5090',
    gpuDisplayName: 'RTX 5090',
    hourlyPriceMicroUsd: 890_000,
    observationId: IDS.observationId,
    receiptId: IDS.receiptId,
    inventoryObservedAt: '2026-08-03T12:00:00.000Z',
    priceConfirmedAt: '2026-08-03T12:00:01.000Z',
  } as const;
  return {
    schemaVersion: 1,
    storeRevision: 4,
    record: {
      schemaVersion: 1,
      switchId: IDS.switchId,
      recordRevision: 1,
      phase: 'planned',
      blockedAt: null,
      attentionCode: null,
      authorizationRequired: false,
      targetConfirmation: 'required',
      oldPod: {
        podId: 'pod-old-1',
        gpuId: 'NVIDIA GeForce RTX 4090',
        gpuDisplayName: 'RTX 4090',
        hourlyPriceMicroUsd: 690_000,
      },
      initialTarget: target,
      currentTarget: target,
      preparedTarget: null,
      priorAttempts: [],
      queueReservation: { active: true, queueRunRevision: IDS.queueRunRevision },
      expectedBatchId: null,
      oldDeleteWireAttempts: 0,
      replacementPodId: null,
      peerPodIds: [],
      peerPodOverflow: false,
      actualHourlyPriceMicroUsd: null,
      confirmedActualPrice: false,
      createdAt: '2026-08-03T12:00:02.000Z',
      updatedAt: '2026-08-03T12:00:02.000Z',
    },
    issues: [],
  };
}

const choice = {
  observationId: IDS.observationId,
  receiptId: IDS.receiptId,
  targetGpuId: 'NVIDIA GeForce RTX 5090',
  confirmedHourlyPriceMicroUsd: 890_000,
} as const;

describe('native GPU Switch bridge', () => {
  beforeEach(() => invoke.mockReset());

  it('strictly parses a safe snapshot and rejects unknown fields and attempt gaps', () => {
    const value = snapshot();
    expect(parseNativeGpuSwitchSnapshotV1(value)).toEqual(value);
    expect(parseNativeGpuSwitchSnapshotV1({ ...value, providerBody: {} })).toBeNull();
    expect(parseNativeGpuSwitchSnapshotV1({
      ...value,
      record: {
        ...value.record!,
        currentTarget: { ...value.record!.currentTarget, attemptRevision: 2 },
      },
    })).toBeNull();
  });

  it('enforces the durable target-confirmation phase relation after reload', () => {
    const value = snapshot();
    expect(parseNativeGpuSwitchSnapshotV1({
      ...value,
      record: { ...value.record!, phase: 'planned', targetConfirmation: 'confirmed' },
    })).toBeNull();
    expect(parseNativeGpuSwitchSnapshotV1({
      ...value,
      record: { ...value.record!, phase: 'consent_pending', targetConfirmation: 'required' },
    })).not.toBeNull();
    expect(parseNativeGpuSwitchSnapshotV1({
      ...value,
      record: { ...value.record!, phase: 'consent_pending', targetConfirmation: 'confirmed' },
    })).not.toBeNull();
    expect(parseNativeGpuSwitchSnapshotV1({
      ...value,
      record: { ...value.record!, phase: 'pausing', targetConfirmation: 'required' },
    })).toBeNull();
  });

  it('uses the attention registry phase relation rather than the duplicate issue entry', () => {
    const value = snapshot();
    const pauseAttention = {
      ...value,
      record: {
        ...value.record!,
        phase: 'needs_attention' as const,
        blockedAt: 'pausing' as const,
        attentionCode: 'gpu_switch_pause_failed' as const,
        targetConfirmation: 'confirmed' as const,
      },
      issues: [{ code: 'gpu_switch_pause_failed', retryable: false }],
    };
    expect(parseNativeGpuSwitchSnapshotV1(pauseAttention)).not.toBeNull();
    expect(parseNativeGpuSwitchSnapshotV1({
      ...pauseAttention,
      record: { ...pauseAttention.record, blockedAt: 'old_absent' },
    })).toBeNull();
  });

  it('uses only the exact load, foreground, begin, and lease command inputs', async () => {
    invoke.mockResolvedValueOnce(snapshot());
    await expect(nativeGpuSwitchLoad()).resolves.toEqual(snapshot());
    expect(invoke).toHaveBeenLastCalledWith('gpu_switch_load');

    const grant = {
      schemaVersion: 1,
      grantId: IDS.grantId,
      processEpochId: IDS.epochId,
      action: 'begin',
      expiresAt: '2026-08-03T12:00:05.000Z',
    } as const;
    invoke.mockResolvedValueOnce(grant);
    await expect(nativeGpuSwitchAuthorizeForeground({
      action: 'begin',
      switchId: null,
      observationId: IDS.observationId,
      targetGpuId: choice.targetGpuId,
    })).resolves.toEqual(grant);
    expect(invoke).toHaveBeenLastCalledWith('gpu_switch_authorize_foreground', {
      input: {
        action: 'begin',
        switchId: null,
        observationId: IDS.observationId,
        targetGpuId: choice.targetGpuId,
      },
    });

    const begin = {
      ...choice,
      expectedStoreRevision: 0,
      sessionId: IDS.sessionId,
      queueExpectedStoreRevision: 3,
      queueRunRevision: IDS.queueRunRevision,
      foregroundGrantId: IDS.grantId,
    } as const;
    invoke.mockResolvedValueOnce(snapshot());
    await expect(nativeGpuSwitchBegin(begin)).resolves.toEqual(snapshot());
    expect(invoke).toHaveBeenLastCalledWith('gpu_switch_begin', { input: begin });

    invoke.mockResolvedValueOnce({ switchId: IDS.switchId, held: true });
    await expect(nativeGpuSwitchAcquire({
      switchId: IDS.switchId,
      foregroundGrantId: IDS.grantId,
    })).resolves.toEqual({ switchId: IDS.switchId, held: true });
    invoke.mockResolvedValueOnce({ switchId: IDS.switchId, held: false });
    await expect(nativeGpuSwitchRelease({ switchId: IDS.switchId }))
      .resolves.toEqual({ switchId: IDS.switchId, held: false });
  });

  it('maps every post-begin action to its narrow registered command name', async () => {
    const revision = { switchId: IDS.switchId, expectedRecordRevision: 1 } as const;
    const worker = { ...revision, sessionId: IDS.sessionId } as const;
    const fresh = { ...worker, ...choice } as const;
    const prepare = { ...revision, ...choice } as const;
    const cases: Array<readonly [string, () => Promise<NativeGpuSwitchSnapshotV1>]> = [
      ['gpu_switch_sync_worker', () => nativeGpuSwitchSyncWorker(worker)],
      ['gpu_switch_finalize', () => nativeGpuSwitchFinalize(fresh)],
      ['gpu_switch_confirm_target', () => nativeGpuSwitchConfirmTarget(prepare)],
      ['gpu_switch_delete_old', () => nativeGpuSwitchDeleteOld(fresh)],
      ['gpu_switch_prepare_attempt', () => nativeGpuSwitchPrepareAttempt(prepare)],
      ['gpu_switch_confirm_attempt', () => nativeGpuSwitchConfirmAttempt({ ...prepare, quoteId: IDS.quoteId })],
      ['gpu_switch_create_replacement', () => nativeGpuSwitchCreateReplacement(fresh)],
      ['gpu_switch_confirm_actual_price', () => nativeGpuSwitchConfirmActualPrice({ ...revision, confirmedActualHourlyPriceMicroUsd: 900_000 })],
      ['gpu_switch_delete_replacement', () => nativeGpuSwitchDeleteReplacement({
        ...revision,
        replacementPodId: 'pod-replacement-1',
        reason: 'replacement_failed',
        confirmation: 'TERMINATE FAILED REPLACEMENT',
      })],
      ['gpu_switch_reconcile_provider', () => nativeGpuSwitchReconcileProvider({ ...revision, reason: 'after_create' })],
      ['gpu_switch_verify_replacement', () => nativeGpuSwitchVerifyReplacement(worker)],
      ['gpu_switch_complete', () => nativeGpuSwitchComplete(worker)],
      ['gpu_switch_cancel', () => nativeGpuSwitchCancel(worker)],
    ];
    for (const [command, call] of cases) {
      invoke.mockResolvedValueOnce(snapshot());
      await expect(call(), command).resolves.toEqual(snapshot());
      expect(invoke, command).toHaveBeenLastCalledWith(command, { input: expect.any(Object) });
    }
  });

  it('rejects malformed inputs before invoking native authority', async () => {
    await expect(nativeGpuSwitchAuthorizeForeground({
      action: 'resume',
      switchId: IDS.switchId,
      observationId: IDS.observationId,
      targetGpuId: null,
    } as never)).rejects.toThrow('input is invalid');
    await expect(nativeGpuSwitchConfirmActualPrice({
      switchId: IDS.switchId,
      expectedRecordRevision: 1,
      confirmedActualHourlyPriceMicroUsd: Number.MAX_SAFE_INTEGER + 1,
    })).rejects.toThrow('input is invalid');
    await expect(nativeGpuSwitchDeleteReplacement({
      switchId: IDS.switchId,
      expectedRecordRevision: 1,
      replacementPodId: 'pod-replacement-1',
      reason: 'replacement_failed',
      confirmation: 'TERMINATE UNACCEPTED REPLACEMENT',
    })).rejects.toThrow('input is invalid');
    expect(invoke).not.toHaveBeenCalled();
  });
});
