import { render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryQueueHost } from '../adapters/queueStore';
import { createEmptyQueueSnapshot, updateQueueRun, type NativeQueueItemV1 } from '../domain/queue';
import {
  QueueReleaseSmokeController,
  QueueReleaseSmokeHarness,
  normalizeTrustedEventTimestamp,
  runQueueReleaseSmoke,
  type QueueReleaseSmokeRuntime,
} from './queueReleaseSmoke';
import type {
  NativeQueueReleaseSmokeInputV1,
  NativeQueueReleaseSmokeResultV1,
  QueueReleaseSmokeEvidenceV1,
} from './tauriBridge';

const NOW = '2026-08-03T12:00:00.000Z';

function uuid(index: number, variant = '8') {
  return `00000000-0000-4000-${variant}000-${index.toString(16).padStart(12, '0')}`;
}

function item(index: number): NativeQueueItemV1 {
  return {
    schemaVersion: 1,
    queueItemId: uuid(index + 1),
    clientSubmissionId: uuid(index + 1_000, '9'),
    recordRevision: 1,
    runRevision: null,
    remoteBatchId: null,
    state: 'staged',
    attentionCode: null,
    name: `Queue release smoke batch ${index + 1}`,
    prompts: [`Prompt ${index + 1}`],
    baseSeed: 100_000 + index,
    destination: '/queue-release-output',
    aspectRatio: '16:9',
    styleSuffix: null,
    references: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('queue release smoke', () => {
  it('normalizes epoch-domain trusted event timestamps to performance time', () => {
    expect(normalizeTrustedEventTimestamp(1_700_000_000_123, 123.4, 1_700_000_000_000)).toBe(123);
    expect(normalizeTrustedEventTimestamp(123.4, 123.4, 1_700_000_000_000)).toBe(123.4);
    expect(normalizeTrustedEventTimestamp(12_000, 123.4, 1_700_000_000_000)).toBeNull();
  });

  it('renders the real queue and active prompt views within their 450-row DOM caps', async () => {
    const controller = new QueueReleaseSmokeController();
    render(createElement(QueueReleaseSmokeHarness, { controller }));
    controller.publish({
      ...createEmptyQueueSnapshot(),
      storeRevision: 1,
      document: {
        schemaVersion: 1,
        items: Array.from({ length: 450 }, (_, index) => item(index)),
        run: null,
        alarm: null,
      },
    });

    await screen.findByLabelText('450 local queue batches');
    await screen.findByLabelText('450 prompts');
    await waitFor(() => {
      expect(document.querySelectorAll('.queue-row').length).toBeGreaterThan(0);
      expect(document.querySelectorAll('.prompt-row').length).toBeGreaterThan(0);
    });
    expect(document.querySelectorAll('.queue-row').length).toBeLessThanOrEqual(40);
    expect(document.querySelectorAll('.prompt-row').length).toBeLessThanOrEqual(30);

    const trackedId = item(1).queueItemId;
    expect(controller.getSnapshot().document.items.findIndex((row) => row.queueItemId === trackedId)).toBe(1);
    controller.dispatch({ type: 'MOVE_QUEUE_ITEM', queueItemId: trackedId, direction: 1 });
    expect(controller.getSnapshot().document.items.findIndex((row) => row.queueItemId === trackedId)).toBe(2);
  });

  it('uses three process epochs for restart authorization, native settlement, snooze, and final relaunch evidence', async () => {
    const host = createMemoryQueueHost(createEmptyQueueSnapshot(), {
      now: () => Date.parse(NOW),
      deliverAlert: () => 'permission_denied',
    });
    const controller = new QueueReleaseSmokeController();
    let minimized = false;
    let phase: 'run' | 'resume' | 'relaunch' = 'run';
    let writtenEvidence: QueueReleaseSmokeEvidenceV1 | null = null;
    const settledOrdinals: number[] = [];
    const powerTransitions: boolean[] = [];
    const checkpointRestart = vi.fn(async () => ({
      schemaVersion: 1 as const,
      operation: 'checkpoint_restart' as const,
      written: true as const,
      artifactSha256: 'a'.repeat(64),
    }));
    const observeRestart = vi.fn(async () => ({
      schemaVersion: 1 as const,
      operation: 'observe_restart' as const,
      observed: true as const,
      phaseOnePid: 101,
      artifactSha256: 'a'.repeat(64),
    }));
    const finalizeRelaunch = vi.fn(async () => undefined);
    const exchange = vi.fn(async (
      input: NativeQueueReleaseSmokeInputV1,
    ): Promise<NativeQueueReleaseSmokeResultV1> => {
      if (input.operation === 'bootstrap') {
        return {
          schemaVersion: 1,
          operation: 'bootstrap',
          platform: 'macos',
          architecture: 'aarch64',
          appVersion: '0.1.9',
          destination: '/queue-release-output',
        };
      }
      if (input.operation === 'audit') {
        return { schemaVersion: 1, operation: 'audit', runPodCreateCalls: 0, runPodDeleteCalls: 0 };
      }
      if (input.operation === 'write_evidence') {
        writtenEvidence = input.evidence;
        return {
          schemaVersion: 1,
          operation: 'write_evidence',
          written: true,
          evidenceSha256: 'a'.repeat(64),
        };
      }
      if (input.operation === 'write_failure') {
        return { schemaVersion: 1, operation: 'write_failure', written: true };
      }
      return {
        schemaVersion: 1,
        operation: 'dispatch_trusted_key',
        sampleIndex: input.sampleIndex,
        dispatched: true,
      };
    });
    const runtime: QueueReleaseSmokeRuntime = {
      exchange,
      phase: async () => phase,
      settleBatch: async (input) => {
        settledOrdinals.push(input.ordinal);
        return {
          schemaVersion: 1,
          operation: 'settle_batch',
          ordinal: input.ordinal,
          receiptCount: 1,
          artifactSha256: input.ordinal.toString(16).repeat(64).slice(0, 64),
        };
      },
      setPower: async (input) => {
        powerTransitions.push(input.enabled);
        const state = await host.setSleepPrevention({ runRevision: input.runRevision, enabled: input.enabled });
        return { schemaVersion: 1, operation: 'set_power', ...state };
      },
      checkpointRestart,
      observeRestart,
      recordUiFacts: async () => undefined,
      signalPermissionDenied: async (eventId) => {
        const alert = await host.signalAlert({ eventId, kind: 'complete' });
        if (alert.disposition !== 'permission_denied') throw new Error('permission-denied fixture failed');
        return {
          schemaVersion: 1,
          operation: 'signal_permission_denied',
          eventId: alert.eventId,
          notificationId: alert.notificationId,
          disposition: 'permission_denied',
        };
      },
      finalizeRelaunch,
      load: host.load,
      commit: host.commit,
      prepareDispatch: host.prepareDispatch,
      acquireRunner: host.acquireRunner,
      releaseRunner: host.releaseRunner,
      measureUi: async () => ({
        maxMountedQueueRows: 12,
        maxMountedPromptRows: 15,
        horizontalOverflowPx: 0,
        viewportWidth: 1440,
        viewportHeight: 900,
        keyboardSamplesMs: Array.from({ length: 30 }, (_, index) => index + 1),
        trustedSampleCount: 30,
      }),
      measureViewports: async () => ([
        { width: 1280, height: 720, horizontalOverflowPx: 0, clippedAction: false, mountedQueueRows: 12, mountedPromptRows: 15 },
        { width: 1440, height: 900, horizontalOverflowPx: 0, clippedAction: false, mountedQueueRows: 12, mountedPromptRows: 15 },
        { width: 1920, height: 1080, horizontalOverflowPx: 0, clippedAction: false, mountedQueueRows: 12, mountedPromptRows: 15 },
      ]),
      observeAlarmUi: async () => ({
        alarmRole: 'alert',
        ringNowVisible: true,
        snoozeVisible: true,
        permissionDeniedFallbackVisible: true,
        trustedRingNowActivation: true,
        webAudioRingSucceeded: true,
        queueListSemantic: true,
        promptListSemantic: true,
        liveRegionPresent: true,
        focusedControlLabel: 'Ring now',
        viewports: [
          { width: 1280, height: 720, horizontalOverflowPx: 0, clippedAction: false, mountedQueueRows: 12, mountedPromptRows: 15 },
          { width: 1440, height: 900, horizontalOverflowPx: 0, clippedAction: false, mountedQueueRows: 12, mountedPromptRows: 15 },
          { width: 1920, height: 1080, horizontalOverflowPx: 0, clippedAction: false, mountedQueueRows: 12, mountedPromptRows: 15 },
        ],
      }),
      minimize: async () => { minimized = true; },
      isMinimized: async () => minimized,
      restore: async () => { minimized = false; },
      wait: async () => undefined,
      ringAudio: async () => undefined,
      stopAudio: () => undefined,
      disposeAudio: () => undefined,
      now: () => NOW,
      smokeId: () => '44444444-4444-4444-8444-444444444444',
    };

    expect(await runQueueReleaseSmoke(controller, runtime)).toBeNull();
    expect(checkpointRestart).toHaveBeenCalledTimes(1);
    expect(settledOrdinals).toEqual([1]);

    // Simulate process exit at the native boundary: the OS drops power and
    // the new queue process persists paused/auth-required before renderer work.
    let snapshot = await host.load();
    await host.setSleepPrevention({ runRevision: snapshot.document.run!.runRevision, enabled: false });
    snapshot = await host.commit({
      expectedRevision: snapshot.storeRevision,
      document: updateQueueRun(snapshot.document, { runnerState: 'paused', authorizationRequired: true }),
      referenceBlobs: [],
    });
    await host.releaseRunner({ runRevision: snapshot.document.run!.runRevision });

    phase = 'resume';
    const evidence = await runQueueReleaseSmoke(controller, runtime);
    expect(evidence).not.toBeNull();
    expect(writtenEvidence).toEqual(evidence);
    expect(observeRestart).toHaveBeenCalledTimes(1);
    expect(settledOrdinals).toEqual([1, 2, 3]);
    expect(evidence?.queue.batches.map((batch) => batch.ordinal)).toEqual([1, 2, 3]);
    expect(evidence?.alarm).toMatchObject({ signalCalls: 1, uniqueEvents: 1, fixedPoint: true });
    expect(evidence?.runPod).toEqual({ createCalls: 0, deleteCalls: 0 });

    snapshot = await host.load();
    const cohort = new Set(snapshot.document.run?.cohortItemIds ?? []);
    expect(snapshot.document.items.filter((row) => cohort.has(row.queueItemId)).map((row) => row.state))
      .toEqual(['completed', 'completed', 'completed']);
    expect(snapshot.document.items.filter((row) => !cohort.has(row.queueItemId) && row.state === 'staged'))
      .toHaveLength(447);
    expect(snapshot.document.run).toMatchObject({ runnerState: 'completed', authorizationRequired: true });
    expect(snapshot.document.alarm).toMatchObject({
      state: 'snoozed',
      kind: 'complete',
      snoozeUsed: true,
      snoozeDueAt: '2026-08-03T12:15:00.000Z',
      notificationDisposition: 'permission_denied',
    });
    expect(powerTransitions).toEqual([true, true, false]);
    expect(exchange.mock.calls.filter(([input]) => input.operation === 'write_evidence')).toHaveLength(1);
    expect(exchange.mock.calls.filter(([input]) => input.operation === 'write_failure')).toHaveLength(0);

    phase = 'relaunch';
    expect(await runQueueReleaseSmoke(controller, runtime)).toBeNull();
    expect(finalizeRelaunch).toHaveBeenCalledTimes(1);
    expect(exchange.mock.calls.filter(([input]) => input.operation === 'write_failure')).toHaveLength(0);
  });
});
