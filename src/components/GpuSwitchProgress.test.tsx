import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StudioGpuSwitchState } from '../domain/types';
import type { NativeGpuSwitchPhaseV1, NativeGpuSwitchSnapshotV1 } from '../native/gpuSwitchBridge';
import { GpuSwitchProgress, type GpuSwitchProgressActionV1 } from './GpuSwitchProgress';

function snapshot(input: Partial<NativeGpuSwitchSnapshotV1['record']> = {}): NativeGpuSwitchSnapshotV1 {
  const target = {
    replacementAttemptId: '11111111-1111-4111-8111-111111111111',
    attemptRevision: 1,
    gpuId: 'NVIDIA GeForce RTX 5090',
    gpuDisplayName: 'RTX 5090',
    hourlyPriceMicroUsd: 890_000,
    observationId: '22222222-2222-4222-8222-222222222222',
    receiptId: '33333333-3333-4333-8333-333333333333',
    inventoryObservedAt: '2026-08-04T00:00:00.000Z',
    priceConfirmedAt: '2026-08-04T00:00:01.000Z',
  } as const;
  return {
    schemaVersion: 1,
    storeRevision: 2,
    record: {
      schemaVersion: 1,
      switchId: '44444444-4444-4444-8444-444444444444',
      recordRevision: 3,
      phase: 'consent_pending',
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
      queueReservation: { active: true, queueRunRevision: null },
      expectedBatchId: null,
      oldDeleteWireAttempts: 0,
      replacementPodId: null,
      peerPodIds: [],
      peerPodOverflow: false,
      actualHourlyPriceMicroUsd: null,
      confirmedActualPrice: false,
      createdAt: '2026-08-04T00:00:02.000Z',
      updatedAt: '2026-08-04T00:00:02.000Z',
      ...input,
    },
    issues: [],
  };
}

function worker(phase: StudioGpuSwitchState['phase']): StudioGpuSwitchState {
  return {
    switchId: '44444444-4444-4444-8444-444444444444',
    oldPodId: 'pod-old-1',
    oldGpuId: 'NVIDIA GeForce RTX 4090',
    oldGpuDisplayName: 'RTX 4090',
    initialTargetGpuId: 'NVIDIA GeForce RTX 5090',
    initialTargetGpuDisplayName: 'RTX 5090',
    requester: { sessionId: '55555555-5555-4555-8555-555555555555', displayName: 'Lakshman' },
    isRequester: true,
    canRespond: false,
    phase,
    reason: null,
    requestedAt: '2026-08-04T00:00:00.000Z',
    responseDeadline: '2026-08-04T00:00:30.000Z',
    readyToDeleteAt: null,
    waitingFor: [],
    approvedBy: [],
    deniedBy: [],
    batchId: null,
    batchOwner: null,
    batchProgress: null,
    batchStateAtFinalization: null,
    replacementPodId: null,
    actualTargetGpuId: null,
  };
}

describe('GpuSwitchProgress', () => {
  it.each([
    ['planned', 'Recovering switch setup'],
    ['consent_pending', 'Waiting for switch approval'],
    ['pausing', 'Finishing the current image'],
    ['ready_to_delete', 'Ready to terminate the current Pod'],
    ['delete_intent', 'Terminating the current Pod'],
    ['delete_uncertain', 'Checking the current Pod deletion'],
    ['old_absent', 'Current Pod is off'],
    ['create_intent', 'Starting the replacement Pod'],
    ['create_uncertain', 'Checking whether the replacement was created'],
    ['replacement_identified', 'Replacement found'],
    ['provisioning', 'Replacement GPU is provisioning'],
    ['replacement_failed', 'Replacement needs attention'],
    ['replacement_delete_intent', 'Terminating the failed replacement'],
    ['replacement_delete_uncertain', 'Checking failed-replacement termination'],
    ['ready_paused', 'Replacement GPU is ready'],
    ['completed', 'GPU switch complete'],
    ['needs_attention', 'GPU switch needs attention'],
    ['cancelled_pre_delete', 'GPU switch cancelled'],
  ] satisfies ReadonlyArray<readonly [NativeGpuSwitchPhaseV1, string]>) (
    'renders authored progress copy for %s',
    (phase, title) => {
      render(
        <GpuSwitchProgress
          snapshot={snapshot({
            phase,
            targetConfirmation: phase === 'planned' || phase === 'consent_pending'
              ? 'required'
              : 'confirmed',
            blockedAt: phase === 'needs_attention' ? 'pausing' : null,
            attentionCode: phase === 'needs_attention' ? 'gpu_switch_pause_failed' : null,
          })}
          workerRequest={worker(phase === 'consent_pending' ? 'pending' : 'needs_attention')}
          busyAction={null}
          onAction={vi.fn()}
        />,
      );

      expect(screen.getByText(title)).toBeVisible();
      expect(screen.getByText(/RTX 4090 → RTX 5090/)).toBeVisible();
    },
  );

  it('makes fresh resume authority the only action when native authorization is absent', () => {
    const onAction = vi.fn();
    render(
      <GpuSwitchProgress
        snapshot={snapshot({ authorizationRequired: true })}
        workerRequest={worker('approved')}
        busyAction={null}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Resume switch' }));
    expect(onAction).toHaveBeenCalledWith('resume');
    expect(screen.queryByRole('button', { name: 'Finalize switch' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel switch' })).toBeNull();
  });

  it('shows one durable confirmation step before finalization after approval', () => {
    const onAction = vi.fn();
    const { rerender } = render(
      <GpuSwitchProgress
        snapshot={snapshot()}
        workerRequest={worker('approved')}
        busyAction={null}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm target' }));
    expect(onAction).toHaveBeenCalledWith('confirm_target');
    expect(screen.queryByRole('button', { name: 'Finalize switch' })).toBeNull();

    rerender(
      <GpuSwitchProgress
        snapshot={snapshot({ targetConfirmation: 'confirmed', recordRevision: 4 })}
        workerRequest={worker('approved')}
        busyAction={null}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Finalize switch' }));
    expect(onAction).toHaveBeenLastCalledWith('finalize');
  });

  it('offers read-only worker sync while consent is pending and hides generic attention retries', () => {
    const onAction = vi.fn();
    const { rerender } = render(
      <GpuSwitchProgress
        snapshot={snapshot()}
        workerRequest={worker('pending')}
        busyAction={null}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check worker state' }));
    expect(onAction).toHaveBeenCalledWith('sync_worker');
    expect(screen.getByRole('button', { name: 'Cancel switch' })).toBeVisible();

    rerender(
      <GpuSwitchProgress
        snapshot={snapshot({
          phase: 'needs_attention',
          blockedAt: 'pausing',
          attentionCode: 'gpu_switch_pause_failed',
          targetConfirmation: 'confirmed',
        })}
        workerRequest={worker('needs_attention')}
        busyAction={null}
        onAction={onAction}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('blocked at pausing');
    expect(screen.getByRole('button', { name: 'Check provider state' })).toBeVisible();
  });

  it.each([
    [{ phase: 'ready_to_delete', targetConfirmation: 'confirmed' }, 'Terminate current GPU', 'delete_old'],
    [{ phase: 'delete_uncertain', targetConfirmation: 'confirmed' }, 'Check provider state', 'reconcile_provider'],
    [{ phase: 'old_absent', targetConfirmation: 'confirmed' }, 'Start replacement GPU', 'create_replacement'],
    [{
      phase: 'old_absent',
      targetConfirmation: 'confirmed',
      preparedTarget: {
        quoteId: '66666666-6666-4666-8666-666666666666',
        preparedFromRecordRevision: 3,
        gpuId: 'NVIDIA GeForce RTX 5090',
        gpuDisplayName: 'RTX 5090',
        hourlyPriceMicroUsd: 890_000,
        observationId: '22222222-2222-4222-8222-222222222222',
        receiptId: '33333333-3333-4333-8333-333333333333',
        preparedAt: '2026-08-04T00:00:03.000Z',
        expiresAt: '2026-08-04T00:01:03.000Z',
      },
    }, 'Confirm replacement attempt', 'confirm_attempt'],
    [{
      phase: 'replacement_identified',
      targetConfirmation: 'confirmed',
      replacementPodId: 'pod-replacement-1',
      actualHourlyPriceMicroUsd: 910_000,
    }, 'Accept actual price', 'confirm_actual_price'],
    [{
      phase: 'replacement_failed',
      targetConfirmation: 'confirmed',
      replacementPodId: 'pod-replacement-1',
    }, 'Terminate replacement', 'delete_replacement'],
    [{
      phase: 'provisioning',
      targetConfirmation: 'confirmed',
      replacementPodId: 'pod-replacement-1',
      actualHourlyPriceMicroUsd: 890_000,
      confirmedActualPrice: true,
    }, 'Verify replacement', 'verify_replacement'],
    [{
      phase: 'replacement_delete_uncertain',
      targetConfirmation: 'confirmed',
      replacementPodId: 'pod-replacement-1',
    }, 'Check provider state', 'reconcile_provider'],
    [{
      phase: 'ready_paused',
      targetConfirmation: 'confirmed',
      replacementPodId: 'pod-replacement-1',
      actualHourlyPriceMicroUsd: 890_000,
      confirmedActualPrice: true,
    }, 'Complete switch', 'complete'],
    [{
      phase: 'needs_attention',
      blockedAt: 'planned',
      attentionCode: 'gpu_switch_worker_response_invalid',
    }, 'Cancel switch', 'cancel'],
  ] satisfies ReadonlyArray<readonly [
    Partial<NativeGpuSwitchSnapshotV1['record']>,
    string,
    GpuSwitchProgressActionV1,
  ]>)('maps later native phase to explicit %s action', (record, label, action) => {
    const onAction = vi.fn();
    render(
      <GpuSwitchProgress
        snapshot={snapshot(record)}
        workerRequest={worker('needs_attention')}
        busyAction={null}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(onAction).toHaveBeenCalledWith(action);
  });
});
