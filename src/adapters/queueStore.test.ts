import { describe, expect, it } from 'vitest';
import { appReducer, createConfiguredInitialState } from '../domain/reducer';
import {
  createQueueRun,
  createStagedQueueItem,
  removeQueueItem,
  updateQueueItem,
  updateQueueRun,
  type NativeQueueDocumentV1,
  type NativeQueueItemV1,
  type NativeQueueItemPlaceholderV1,
} from '../domain/queue';
import type { BatchReference } from '../domain/types';
import { createMemoryQueueHost, queueNotificationId, snapshotQueueReferences } from './queueStore';

const NOW = '2026-08-03T12:00:00.000Z';
const LATER = '2026-08-03T12:01:00.000Z';
const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const SUBMISSION_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const REMOTE_ID = '44444444-4444-4444-8444-444444444444';
const REFERENCE_ID = '55555555-5555-4555-8555-555555555555';

function staged(reference: Awaited<ReturnType<typeof snapshotQueueReferences>> = []) {
  let state = createConfiguredInitialState();
  state = appReducer(state, { type: 'SET_PROMPT_TEXT', text: 'A quiet editorial frame at dawn' });
  state = appReducer(state, { type: 'SET_DESTINATION', path: '/safe/imageforge-output' });
  const ids = [ITEM_ID, SUBMISSION_ID];
  let cursor = 0;
  return createStagedQueueItem(state.draft, state.settings, reference, NOW, () => ids[cursor++]);
}

function completeDocument(): NativeQueueDocumentV1 {
  const stagedItem = staged().item;
  let document = createQueueRun(
    { schemaVersion: 1, items: [stagedItem], run: null, alarm: null },
    RUN_ID,
    true,
    false,
  );
  document = updateQueueItem(document, ITEM_ID, { state: 'dispatching', attentionCode: null }, LATER);
  document = updateQueueItem(document, ITEM_ID, { state: 'active', attentionCode: null, remoteBatchId: REMOTE_ID }, LATER);
  document = updateQueueItem(document, ITEM_ID, { state: 'saving', attentionCode: null }, LATER);
  document = updateQueueItem(document, ITEM_ID, { state: 'completed', attentionCode: null }, LATER);
  document = updateQueueRun(document, { runnerState: 'completed', authorizationRequired: true });
  return {
    ...document,
    alarm: {
      ...document.alarm!,
      state: 'ringing',
      kind: 'complete',
      notificationDisposition: 'pending',
    },
  };
}

describe('memory queue native contract fake', () => {
  it('requires the durable run before acquiring its process lease', async () => {
    const host = createMemoryQueueHost();
    await expect(host.acquireRunner({ runRevision: RUN_ID })).rejects.toMatchObject({ code: 'queue_runner_busy' });
    const item = staged().item;
    const stagedDocument = { schemaVersion: 1 as const, items: [item], run: null, alarm: null };
    await host.commit({ expectedRevision: 0, document: stagedDocument, referenceBlobs: [] });
    const document = createQueueRun(stagedDocument, RUN_ID, false, false);
    await host.commit({ expectedRevision: 1, document, referenceBlobs: [] });
    await expect(host.acquireRunner({ runRevision: RUN_ID })).resolves.toEqual({ runRevision: RUN_ID, held: true });
    await expect(host.releaseRunner({ runRevision: RUN_ID })).resolves.toEqual({ runRevision: RUN_ID, held: false });
  });

  it('serializes optimistic revisions and preserves the last committed snapshot', async () => {
    const host = createMemoryQueueHost();
    const item = staged().item;
    const document = { schemaVersion: 1 as const, items: [item], run: null, alarm: null };
    const committed = await host.commit({ expectedRevision: 0, document, referenceBlobs: [] });
    expect(committed.storeRevision).toBe(1);
    await expect(host.commit({ expectedRevision: 0, document, referenceBlobs: [] })).rejects.toMatchObject({ code: 'queue_revision_conflict' });
    expect((await host.load()).document.items[0].queueItemId).toBe(ITEM_ID);
  });

  it('copies reference bytes privately and returns them only for exact dispatch', async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
    const input: BatchReference = {
      id: 'renderer-reference',
      name: 'anchor.png',
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      bytes,
    };
    const references = await snapshotQueueReferences([input], () => REFERENCE_ID);
    const snapshot = staged(references);
    const host = createMemoryQueueHost();
    const stagedDocument = { schemaVersion: 1 as const, items: [snapshot.item], run: null, alarm: null };
    await host.commit({ expectedRevision: 0, document: stagedDocument, referenceBlobs: snapshot.referenceBlobs });
    const document = createQueueRun(stagedDocument, RUN_ID, false, false);
    await host.commit({ expectedRevision: 1, document, referenceBlobs: [] });
    await host.acquireRunner({ runRevision: RUN_ID });
    const running = updateQueueRun(document, { runnerState: 'running', authorizationRequired: false });
    await host.commit({ expectedRevision: 2, document: running, referenceBlobs: [] });
    const payload = await host.prepareDispatch({ queueItemId: ITEM_ID, clientSubmissionId: SUBMISSION_ID, purpose: 'dispatch' });
    expect(payload.references[0]).toMatchObject({ id: REFERENCE_ID, bytes });
    await expect(host.prepareDispatch({ queueItemId: ITEM_ID, clientSubmissionId: REMOTE_ID, purpose: 'dispatch' })).rejects.toMatchObject({ code: 'queue_item_not_found' });
  });

  it('cancels an assigned reference-damaged row without requiring the missing bytes', async () => {
    const reference = {
      id: REFERENCE_ID,
      name: 'missing.png',
      mimeType: 'image/png' as const,
      sizeBytes: 12,
      sha256: 'a'.repeat(64),
    };
    const stagedItem = { ...staged().item, references: [reference] };
    let document = createQueueRun(
      { schemaVersion: 1, items: [stagedItem], run: null, alarm: null },
      RUN_ID,
      false,
      false,
    );
    document = updateQueueItem(document, ITEM_ID, {
      state: 'needs_attention',
      attentionCode: 'queue_reference_missing',
    }, LATER);
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 3, document, issues: [] });
    await host.acquireRunner({ runRevision: RUN_ID });
    const cancelled = removeQueueItem(document, ITEM_ID, LATER);
    await expect(host.commit({ expectedRevision: 3, document: cancelled, referenceBlobs: [] }))
      .resolves.toMatchObject({ document: { items: [expect.objectContaining({ state: 'cancelled' })] } });
  });

  it('deduplicates the durable primary alert and rejects the wrong event', async () => {
    const document = completeDocument();
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 5, document, issues: [] });
    const eventId = `queue-complete:${RUN_ID}`;
    await expect(host.signalAlert({ eventId, kind: 'complete' })).resolves.toMatchObject({ disposition: 'delivered' });
    await expect(host.signalAlert({ eventId, kind: 'complete' })).resolves.toMatchObject({ disposition: 'already_delivered' });
    await expect(host.signalAlert({ eventId: `queue-complete:${REMOTE_ID}`, kind: 'complete' })).rejects.toMatchObject({ code: 'queue_alert_event_invalid' });
  });

  it('rejects alert delivery after the current event is acknowledged', async () => {
    const document = completeDocument();
    document.alarm = { ...document.alarm!, state: 'acknowledged' };
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 5, document, issues: [] });
    await expect(host.signalAlert({ eventId: `queue-complete:${RUN_ID}`, kind: 'complete' }))
      .rejects.toMatchObject({ code: 'queue_alert_event_invalid' });
  });

  it('uses the same stable primary and snooze notification ID vectors as native', async () => {
    const eventId = `queue-complete:${RUN_ID}`;
    await expect(queueNotificationId(eventId, 'complete')).resolves.toBe(2_093_761_350);
    await expect(queueNotificationId(eventId, 'attention')).resolves.toBe(2_093_761_350);
    await expect(queueNotificationId(eventId, 'snooze')).resolves.toBe(894_846_938);
  });

  it('rejects a renderer-forged delivered disposition without a matching outbox result', async () => {
    const document = completeDocument();
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 5, document, issues: [] });
    const forged = {
      ...document,
      alarm: { ...document.alarm!, notificationDisposition: 'delivered' as const },
    };
    await expect(host.commit({ expectedRevision: 5, document: forged, referenceBlobs: [] }))
      .rejects.toMatchObject({ code: 'queue_commit_invalid' });
  });

  it('removes a real corrupt placeholder explicitly without inventing a record', async () => {
    const placeholder: NativeQueueItemPlaceholderV1 = {
      schemaVersion: 1,
      queueItemId: ITEM_ID,
      recordRevision: 4,
      state: 'needs_attention',
      attentionCode: 'queue_item_corrupt',
      name: 'Recovered summary',
      promptCount: 12,
      referenceCount: 1,
      createdAt: NOW,
      updatedAt: LATER,
    };
    const host = createMemoryQueueHost({
      schemaVersion: 1,
      storeRevision: 2,
      document: { schemaVersion: 1, items: [placeholder], run: null, alarm: null },
      issues: [{ code: 'queue_item_corrupt', queueItemId: ITEM_ID, retryable: false }],
    });
    const current = await host.load();
    const document = removeQueueItem(current.document, ITEM_ID, LATER);
    const next = await host.commit({ expectedRevision: 2, document, referenceBlobs: [] });
    expect(next.document.items).toEqual([]);
  });

  it('refuses destructive reset while the store is healthy', async () => {
    const host = createMemoryQueueHost();
    await expect(host.reset({ confirmation: 'RESET LOCAL QUEUE' })).rejects.toMatchObject({ code: 'queue_reset_not_allowed' });
  });

  it('requires the lease for current-run mutation but permits independent Next-run staging', async () => {
    const current = createQueueRun(
      { schemaVersion: 1, items: [staged().item], run: null, alarm: null },
      RUN_ID,
      false,
      false,
    );
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 1, document: current, issues: [] });
    const running = updateQueueRun(current, { runnerState: 'running', authorizationRequired: false });
    await expect(host.commit({ expectedRevision: 1, document: running, referenceBlobs: [] })).rejects.toMatchObject({ code: 'queue_runner_busy' });

    const next = {
      ...staged().item,
      queueItemId: '66666666-6666-4666-8666-666666666666',
      clientSubmissionId: '77777777-7777-4777-8777-777777777777',
      name: 'Next run batch',
    };
    const stagedNext = await host.commit({
      expectedRevision: 1,
      document: { ...current, items: [...current.items, next] },
      referenceBlobs: [],
    });
    expect(stagedNext.document.items).toHaveLength(2);
  });

  it('rejects a crafted item-record revision jump', async () => {
    const current = createQueueRun(
      { schemaVersion: 1, items: [staged().item], run: null, alarm: null },
      RUN_ID,
      false,
      false,
    );
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 1, document: current, issues: [] });
    await host.acquireRunner({ runRevision: RUN_ID });
    const row = current.items[0];
    if ('promptCount' in row) throw new Error('expected a valid queue item');
    const crafted = {
      ...current,
      items: [{ ...row, state: 'dispatching' as const, recordRevision: row.recordRevision + 2 }],
    };
    await expect(host.commit({ expectedRevision: 1, document: crafted, referenceBlobs: [] })).rejects.toMatchObject({ code: 'queue_commit_invalid' });
  });

  it('accepts only the exact revision-two direct admission into a new paused cohort', async () => {
    const item = staged().item;
    const direct = createQueueRun(
      { schemaVersion: 1, items: [item], run: null, alarm: null },
      RUN_ID,
      false,
      false,
    );
    const host = createMemoryQueueHost();
    await expect(host.commit({ expectedRevision: 0, document: direct, referenceBlobs: [] })).resolves.toMatchObject({ storeRevision: 1 });

    const invalidHost = createMemoryQueueHost();
    const row = direct.items[0];
    if ('promptCount' in row) throw new Error('expected a valid queue item');
    const invalid = { ...direct, items: [{ ...row, recordRevision: 3 }] };
    await expect(invalidHost.commit({ expectedRevision: 0, document: invalid, referenceBlobs: [] })).rejects.toMatchObject({ code: 'queue_commit_invalid' });
  });

  it('requires a held running lease and a staged row before dispatch preparation', async () => {
    const item = staged().item;
    const document = createQueueRun(
      { schemaVersion: 1, items: [item], run: null, alarm: null },
      RUN_ID,
      false,
      false,
    );
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 1, document, issues: [] });
    await expect(host.prepareDispatch({ queueItemId: ITEM_ID, clientSubmissionId: SUBMISSION_ID, purpose: 'dispatch' })).rejects.toMatchObject({ code: 'queue_runner_busy' });
    await host.acquireRunner({ runRevision: RUN_ID });
    await expect(host.prepareDispatch({ queueItemId: ITEM_ID, clientSubmissionId: SUBMISSION_ID, purpose: 'dispatch' })).rejects.toMatchObject({ code: 'queue_item_not_dispatchable' });
    const running = updateQueueRun(document, { runnerState: 'running', authorizationRequired: false });
    await host.commit({ expectedRevision: 1, document: running, referenceBlobs: [] });
    const dispatching = updateQueueItem(running, ITEM_ID, { state: 'dispatching', attentionCode: null }, LATER);
    await host.commit({ expectedRevision: 2, document: dispatching, referenceBlobs: [] });
    await expect(host.prepareDispatch({ queueItemId: ITEM_ID, clientSubmissionId: SUBMISSION_ID, purpose: 'dispatch' })).rejects.toMatchObject({ code: 'queue_item_not_dispatchable' });
  });

  it('rejects a prepared dispatch when the durable run pauses before its transition', async () => {
    const item = staged().item;
    const paused = createQueueRun(
      { schemaVersion: 1, items: [item], run: null, alarm: null },
      RUN_ID,
      false,
      false,
    );
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 1, document: paused, issues: [] });
    await host.acquireRunner({ runRevision: RUN_ID });
    const running = updateQueueRun(paused, { runnerState: 'running', authorizationRequired: false });
    await host.commit({ expectedRevision: 1, document: running, referenceBlobs: [] });
    await expect(host.prepareDispatch({
      queueItemId: ITEM_ID,
      clientSubmissionId: SUBMISSION_ID,
      purpose: 'dispatch',
    })).resolves.toMatchObject({ queueItemId: ITEM_ID });

    const pausedAgain = updateQueueRun(running, { runnerState: 'paused', authorizationRequired: true });
    await host.commit({ expectedRevision: 2, document: pausedAgain, referenceBlobs: [] });
    const staleDispatch = updateQueueItem(
      pausedAgain,
      ITEM_ID,
      { state: 'dispatching', attentionCode: null },
      LATER,
    );
    await expect(host.commit({ expectedRevision: 3, document: staleDispatch, referenceBlobs: [] }))
      .rejects.toMatchObject({ code: 'queue_runner_busy' });
  });

  it('allows exact unassigned staged content to be restored only for editing', async () => {
    const item = staged().item;
    const host = createMemoryQueueHost({
      schemaVersion: 1,
      storeRevision: 1,
      document: { schemaVersion: 1, items: [item], run: null, alarm: null },
      issues: [],
    });
    await expect(host.prepareDispatch({
      queueItemId: ITEM_ID,
      clientSubmissionId: SUBMISSION_ID,
      purpose: 'edit',
    })).resolves.toMatchObject({ queueItemId: ITEM_ID, clientSubmissionId: SUBMISSION_ID });
    await expect(host.prepareDispatch({
      queueItemId: ITEM_ID,
      clientSubmissionId: SUBMISSION_ID,
      purpose: 'dispatch',
    })).rejects.toMatchObject({ code: 'queue_runner_busy' });
  });

  it('rejects a new lease and keep-awake assertion after completion', async () => {
    const document = completeDocument();
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 5, document, issues: [] });
    await expect(host.acquireRunner({ runRevision: RUN_ID })).rejects.toMatchObject({ code: 'queue_runner_busy' });

    const running = createQueueRun(
      { schemaVersion: 1, items: [staged().item], run: null, alarm: null },
      RUN_ID,
      false,
      false,
    );
    const activeHost = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 1, document: running, issues: [] });
    await activeHost.acquireRunner({ runRevision: RUN_ID });
    await expect(activeHost.setSleepPrevention({ runRevision: RUN_ID, enabled: true })).rejects.toMatchObject({ code: 'queue_runner_busy' });
  });

  it('rejects clearing or changing an assigned item run revision', async () => {
    const current = createQueueRun(
      { schemaVersion: 1, items: [staged().item], run: null, alarm: null },
      RUN_ID,
      false,
      false,
    );
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 1, document: current, issues: [] });
    await host.acquireRunner({ runRevision: RUN_ID });
    const row = current.items[0];
    if ('promptCount' in row) throw new Error('expected a valid queue item');
    const forged = {
      ...current,
      items: [{ ...row, runRevision: null, recordRevision: row.recordRevision + 1 }],
    };
    await expect(host.commit({ expectedRevision: 1, document: forged, referenceBlobs: [] })).rejects.toMatchObject({ code: 'queue_commit_invalid' });
  });

  it('rejects a renderer rewrite of an admitted prompt snapshot', async () => {
    const current = createQueueRun(
      { schemaVersion: 1, items: [staged().item], run: null, alarm: null },
      RUN_ID,
      false,
      false,
    );
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 1, document: current, issues: [] });
    await host.acquireRunner({ runRevision: RUN_ID });
    const row = current.items[0];
    if ('promptCount' in row) throw new Error('expected a valid queue item');
    const forged = {
      ...current,
      items: [{ ...row, prompts: ['rewritten after admission'], recordRevision: row.recordRevision + 1 }],
    };
    await expect(host.commit({ expectedRevision: 1, document: forged, referenceBlobs: [] }))
      .rejects.toMatchObject({ code: 'queue_commit_invalid' });
  });

  it('rejects an early or extended snooze reminder before native delivery', async () => {
    const completed = completeDocument();
    const snoozed = {
      ...completed,
      alarm: {
        ...completed.alarm!,
        state: 'snoozed' as const,
        snoozeUsed: true,
        snoozeDueAt: LATER,
        snoozeNotificationDisposition: null,
      },
    };
    const host = createMemoryQueueHost(
      { schemaVersion: 1, storeRevision: 5, document: snoozed, issues: [] },
      { now: () => new Date(NOW).valueOf() },
    );
    await expect(host.commit({
      expectedRevision: 5,
      document: {
        ...snoozed,
        alarm: {
          ...snoozed.alarm,
          state: 'ringing',
          snoozeDueAt: null,
          snoozeNotificationDisposition: 'pending',
        },
      },
      referenceBlobs: [],
    })).rejects.toMatchObject({ code: 'queue_commit_invalid' });
    await expect(host.commit({
      expectedRevision: 5,
      document: {
        ...snoozed,
        alarm: { ...snoozed.alarm, snoozeDueAt: '2026-08-03T12:16:00.000Z' },
      },
      referenceBlobs: [],
    })).rejects.toMatchObject({ code: 'queue_commit_invalid' });
  });

  it('requires completion acknowledgement before terminal rows become history', async () => {
    const document = completeDocument();
    const row = document.items[0];
    if ('promptCount' in row) throw new Error('expected a valid queue item');
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 5, document, issues: [] });
    const forged = {
      ...document,
      items: [{ ...row, state: 'historical' as const, recordRevision: row.recordRevision + 1 }],
    };
    await expect(host.commit({ expectedRevision: 5, document: forged, referenceBlobs: [] }))
      .rejects.toMatchObject({ code: 'queue_commit_invalid' });
  });

  it('locks progressed row positions while allowing only acknowledged history omission', async () => {
    const first = staged().item;
    const second = {
      ...staged().item,
      queueItemId: '66666666-6666-4666-8666-666666666666',
      clientSubmissionId: '77777777-7777-4777-8777-777777777777',
      name: 'Second staged row',
    };
    let running = createQueueRun(
      { schemaVersion: 1, items: [first, second], run: null, alarm: null },
      RUN_ID,
      false,
      false,
    );
    running = updateQueueItem(running, ITEM_ID, { state: 'dispatching', attentionCode: null }, LATER);
    const host = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 1, document: running, issues: [] });
    await host.acquireRunner({ runRevision: RUN_ID });
    await expect(host.commit({
      expectedRevision: 1,
      document: { ...running, items: [...running.items].reverse() },
      referenceBlobs: [],
    })).rejects.toMatchObject({ code: 'queue_commit_invalid' });

    const completed = completeDocument();
    const priorHistory: NativeQueueItemV1 = {
      ...staged().item,
      queueItemId: '66666666-6666-4666-8666-666666666666',
      clientSubmissionId: '77777777-7777-4777-8777-777777777777',
      recordRevision: 5,
      runRevision: '55555555-5555-4555-8555-555555555555',
      remoteBatchId: SUBMISSION_ID,
      state: 'historical',
    };
    const withHistory = { ...completed, items: [priorHistory, ...completed.items] };
    const historyHost = createMemoryQueueHost({ schemaVersion: 1, storeRevision: 5, document: withHistory, issues: [] });
    await expect(historyHost.commit({
      expectedRevision: 5,
      document: { ...withHistory, items: completed.items },
      referenceBlobs: [],
    })).rejects.toMatchObject({ code: 'queue_commit_invalid' });
  });
});
