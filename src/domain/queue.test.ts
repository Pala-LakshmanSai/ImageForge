import { describe, expect, it } from 'vitest';
import { appReducer, createConfiguredInitialState } from './reducer';
import {
  assertQueueAlarmTransition,
  assertQueueItemTransition,
  clearQueueHistory,
  createQueueRun,
  createStagedQueueItem,
  createVirtualWindow,
  moveQueueItem,
  nextQueueItem,
  parseNativeQueueSnapshot,
  queueCanStartNewRun,
  queueCohortAtFixedPoint,
  removeQueueItem,
  replaceQueueItem,
  updateQueueItem,
  updateQueueRun,
  type NativeQueueDocumentV1,
  type NativeQueueItemV1,
  type NativeQueueItemPlaceholderV1,
} from './queue';

const NOW = '2026-08-03T12:00:00.000Z';
const LATER = '2026-08-03T12:01:00.000Z';
const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
];

function configuredBrief(name = 'Night editorial') {
  let state = createConfiguredInitialState();
  state = appReducer(state, {
    type: 'SET_PROMPT_TEXT',
    text: 'A documentary shipyard at dawn\nA quiet editorial portrait in window light',
  });
  state = appReducer(state, { type: 'SET_DESTINATION', path: '/safe/imageforge-output' });
  state = {
    ...state,
    draft: { ...state.draft, name },
    settings: { ...state.settings, editorialSuffixEnabled: true, editorialSuffix: 'natural grain' },
  };
  return state;
}

function staged(offset = 0, name?: string): NativeQueueItemV1 {
  const state = configuredBrief(name);
  let cursor = offset;
  return createStagedQueueItem(state.draft, state.settings, [], NOW, () => IDS[cursor++]).item;
}

function documentWith(...items: NativeQueueItemV1[]): NativeQueueDocumentV1 {
  return { schemaVersion: 1, items, run: null, alarm: null };
}

function accepted(document: NativeQueueDocumentV1, queueItemId: string, remoteBatchId = IDS[6]) {
  let next = updateQueueItem(document, queueItemId, { state: 'dispatching', attentionCode: null }, LATER);
  next = updateQueueItem(next, queueItemId, { state: 'active', attentionCode: null, remoteBatchId }, LATER);
  return next;
}

describe('device queue domain', () => {
  it('snapshots canonical prompts, contiguous seeds, style, and independent IDs', () => {
    const state = configuredBrief();
    let cursor = 0;
    const first = createStagedQueueItem(state.draft, state.settings, [], NOW, () => IDS[cursor++]).item;
    const second = createStagedQueueItem(state.draft, state.settings, [], NOW, () => IDS[cursor++]).item;

    expect(first.queueItemId).not.toBe(first.clientSubmissionId);
    expect(second.queueItemId).not.toBe(first.queueItemId);
    expect(first.prompts).toEqual([
      'A documentary shipyard at dawn natural grain',
      'A quiet editorial portrait in window light natural grain',
    ]);
    expect(first.styleSuffix).toBe('natural grain');
    expect(first.baseSeed).toBe(state.draft.prompts[0].seed);
    expect(Number.isSafeInteger(first.baseSeed + first.prompts.length - 1)).toBe(true);
  });

  it('freezes one ordered cohort and keeps later staging in the next run', () => {
    const first = staged(0, 'First');
    const second = staged(2, 'Second');
    let document = createQueueRun(documentWith(first, second), IDS[4], false, true);
    const nextRun = staged(5, 'Later');
    document = replaceQueueItem(document, nextRun, null);

    expect(document.run?.cohortItemIds).toEqual([first.queueItemId, second.queueItemId]);
    expect(nextRun.runRevision).toBeNull();
    expect(() => createQueueRun(document, IDS[6], false, false)).toThrow(/current queue run/i);
    expect(queueCanStartNewRun(document)).toBe(false);
  });

  it('never skips a corrupt current-cohort row to dispatch a later staged item', () => {
    const first = staged(0, 'Damaged first item');
    const second = staged(2, 'Safe successor');
    const admitted = createQueueRun(documentWith(first, second), IDS[4], false, true);
    const placeholder: NativeQueueItemPlaceholderV1 = {
      schemaVersion: 1,
      queueItemId: first.queueItemId,
      recordRevision: first.recordRevision,
      state: 'needs_attention',
      attentionCode: 'queue_item_corrupt',
      name: first.name,
      promptCount: first.prompts.length,
      referenceCount: first.references.length,
      createdAt: first.createdAt,
      updatedAt: first.updatedAt,
    };
    const reconstructed = {
      ...admitted,
      items: [placeholder, admitted.items[1]],
    };

    expect(nextQueueItem(reconstructed)).toBeNull();
  });

  it('allows reorder/removal only for staged peers in the same run', () => {
    const first = staged(0, 'First');
    const second = staged(2, 'Second');
    let document = createQueueRun(documentWith(first, second), IDS[4], false, false);
    document = moveQueueItem(document, second.queueItemId, -1);
    expect(document.run?.cohortItemIds).toEqual([second.queueItemId, first.queueItemId]);

    document = updateQueueItem(document, second.queueItemId, { state: 'dispatching', attentionCode: null }, LATER);
    expect(() => moveQueueItem(document, second.queueItemId, 1)).toThrow(/staged/i);
    document = removeQueueItem(document, first.queueItemId, LATER);
    expect((document.items.find((row) => row.queueItemId === first.queueItemId) as NativeQueueItemV1).state).toBe('cancelled');
  });

  it('removes only reference-damaged attention rows through the explicit recovery path', () => {
    const unassigned = {
      ...staged(0, 'Missing reference'),
      state: 'needs_attention' as const,
      attentionCode: 'queue_reference_missing',
    };
    expect(removeQueueItem(documentWith(unassigned), unassigned.queueItemId, LATER).items).toEqual([]);

    const assignedBase = createQueueRun(documentWith(staged(2, 'Mismatched reference')), IDS[4], false, false);
    const assigned = updateQueueItem(assignedBase, assignedBase.items[0].queueItemId, {
      state: 'needs_attention',
      attentionCode: 'queue_reference_mismatch',
    }, LATER);
    const cancelled = removeQueueItem(assigned, assigned.items[0].queueItemId, LATER).items[0] as NativeQueueItemV1;
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.attentionCode).toBeNull();

    const unavailableDestination = { ...unassigned, attentionCode: 'queue_destination_unavailable' };
    expect(removeQueueItem(
      documentWith(unavailableDestination),
      unavailableDestination.queueItemId,
      LATER,
    ).items).toEqual([]);

    const uncertain = { ...unassigned, attentionCode: 'submission_uncertain' };
    expect(() => removeQueueItem(documentWith(uncertain), uncertain.queueItemId, LATER)).toThrow(/locally damaged/i);
  });

  it('replaces an edited cohort row with fresh IDs in the next run', () => {
    const original = staged(0, 'Original');
    const replacement = staged(2, 'Replacement');
    const document = replaceQueueItem(
      createQueueRun(documentWith(original), IDS[4], false, false),
      replacement,
      original.queueItemId,
    );

    expect((document.items[0] as NativeQueueItemV1).state).toBe('cancelled');
    expect(document.items[1].queueItemId).toBe(replacement.queueItemId);
    expect((document.items[1] as NativeQueueItemV1).runRevision).toBeNull();
  });

  it('enforces exact item transitions, remote association, and saving before terminal', () => {
    const item = staged(0);
    let document = createQueueRun(documentWith(item), IDS[2], false, false);
    expect(() => updateQueueItem(document, item.queueItemId, {
      state: 'completed', attentionCode: null, remoteBatchId: IDS[3],
    }, LATER)).toThrow(/cannot move/i);

    document = accepted(document, item.queueItemId, IDS[3]);
    const active = document.items[0] as NativeQueueItemV1;
    expect(() => assertQueueItemTransition(active, {
      ...active,
      state: 'completed',
      recordRevision: active.recordRevision + 1,
    })).toThrow(/cannot move/i);
    document = updateQueueItem(document, item.queueItemId, { state: 'saving', attentionCode: null }, LATER);
    document = updateQueueItem(document, item.queueItemId, { state: 'completed', attentionCode: null }, LATER);
    expect(queueCohortAtFixedPoint(document)).toBe(true);
    expect(() => updateQueueItem(document, item.queueItemId, { remoteBatchId: IDS[5] }, LATER)).toThrow(/remote batch/i);
  });

  it('rejects early or arbitrary runner completion and permits the fixed point', () => {
    const item = staged(0);
    let document = createQueueRun(documentWith(item), IDS[2], true, false);
    expect(() => updateQueueRun(document, { runnerState: 'completed', authorizationRequired: true })).toThrow(/fixed point/i);
    document = accepted(document, item.queueItemId, IDS[3]);
    document = updateQueueItem(document, item.queueItemId, { state: 'saving', attentionCode: null }, LATER);
    document = updateQueueItem(document, item.queueItemId, { state: 'completed', attentionCode: null }, LATER);
    document = updateQueueRun(document, { runnerState: 'completed', authorizationRequired: true });
    expect(document.run?.runnerState).toBe('completed');
    expect(() => updateQueueRun(document, { runnerState: 'running', authorizationRequired: false })).toThrow(/cannot move/i);
  });

  it('archives only after completion and clears history with the singular run slot', () => {
    const item = staged(0);
    let document = createQueueRun(documentWith(item), IDS[2], false, false);
    document = accepted(document, item.queueItemId, IDS[3]);
    document = updateQueueItem(document, item.queueItemId, { state: 'saving', attentionCode: null }, LATER);
    document = updateQueueItem(document, item.queueItemId, { state: 'completed', attentionCode: null }, LATER);
    document = updateQueueRun(document, { runnerState: 'completed', authorizationRequired: true });
    document = {
      ...document,
      alarm: { ...document.alarm!, state: 'acknowledged', kind: 'complete' },
    };
    document = updateQueueItem(document, item.queueItemId, { state: 'historical', attentionCode: null }, LATER);
    const cleared = clearQueueHistory(document);
    expect(cleared.items).toEqual([]);
    expect(cleared.run).toBeNull();
    expect(cleared.alarm).toBeNull();
  });

  it('strictly parses lifecycle combinations and bounds a 450-row viewport', () => {
    const item = staged(0);
    const document = createQueueRun(documentWith(item), IDS[2], false, false);
    expect(parseNativeQueueSnapshot({ schemaVersion: 1, storeRevision: 1, document, issues: [] }).document.run?.runRevision).toBe(IDS[2]);
    expect(() => parseNativeQueueSnapshot({
      schemaVersion: 1,
      storeRevision: 1,
      document: { ...document, run: { ...document.run!, cohortItemIds: [] } },
      issues: [],
    })).toThrow(/run/i);
    const window = createVirtualWindow(450, 18_000, 76, 304);
    expect(window.end - window.start).toBeLessThanOrEqual(40);
    expect(window.end).toBeLessThanOrEqual(450);
  });

  it('rejects armed alarm acknowledgement and false quiet-delivery state', () => {
    const item = staged(0);
    let document = createQueueRun(documentWith(item), IDS[2], true, false);
    const armed = document.alarm!;
    expect(() => assertQueueAlarmTransition(armed, {
      ...armed,
      state: 'acknowledged',
      kind: 'complete',
    })).toThrow(/cannot move/i);

    document = accepted(document, item.queueItemId, IDS[3]);
    document = updateQueueItem(document, item.queueItemId, { state: 'saving', attentionCode: null }, LATER);
    document = updateQueueItem(document, item.queueItemId, { state: 'completed', attentionCode: null }, LATER);
    document = updateQueueRun(document, { runnerState: 'completed', authorizationRequired: true });
    const falseQuietDelivery = {
      ...document,
      alarm: {
        ...document.alarm!,
        state: 'disarmed' as const,
        kind: 'complete' as const,
        notificationDisposition: 'delivered' as const,
      },
    };
    expect(() => parseNativeQueueSnapshot({
      schemaVersion: 1,
      storeRevision: 1,
      document: falseQuietDelivery,
      issues: [],
    })).toThrow(/alarm lifecycle/i);
  });

  it('matches native item and document validation at the strict snapshot boundary', () => {
    const item = staged(0);
    const reference = {
      id: IDS[5],
      name: 'anchor.png',
      mimeType: 'image/png' as const,
      sizeBytes: 1,
      sha256: '0'.repeat(64),
    };
    const parseItemInEmptyRun = (candidate: NativeQueueItemV1) => parseNativeQueueSnapshot({
      schemaVersion: 1,
      storeRevision: 1,
      document: documentWith(candidate),
      issues: [],
    });

    const invalidItems: NativeQueueItemV1[] = [
      { ...item, clientSubmissionId: item.queueItemId },
      { ...item, name: 'unsafe\nname' },
      { ...item, prompts: ['unsafe\0prompt'] },
      { ...item, styleSuffix: 'unsafe\0style' },
      { ...item, destination: 'relative/output' },
      { ...item, destination: '/safe/output\0elsewhere' },
      { ...item, references: [reference, reference] },
      { ...item, runRevision: IDS[2] },
    ];
    for (const candidate of invalidItems) expect(() => parseItemInEmptyRun(candidate)).toThrow();

    expect(parseItemInEmptyRun({
      ...item,
      destination: '\\\\?\\C:\\safe\\imageforge-output',
    }).document.items[0]).toMatchObject({ destination: '\\\\?\\C:\\safe\\imageforge-output' });
    expect(() => parseItemInEmptyRun({
      ...item,
      destination: '\\\\?\\UNC\\server\\share',
    })).toThrow();

    const second = staged(2);
    const runDocument = createQueueRun(documentWith(item), IDS[4], false, false);
    const nonCohortAssigned = {
      ...runDocument,
      items: [...runDocument.items, { ...second, runRevision: IDS[4] }],
    };
    expect(() => parseNativeQueueSnapshot({
      schemaVersion: 1,
      storeRevision: 1,
      document: nonCohortAssigned,
      issues: [],
    })).toThrow(/cohort/i);
  });

  it('keeps admitted item snapshots and historical rows immutable', () => {
    const item = staged(0);
    const changedPrompt = { ...item, prompts: ['rewritten'], recordRevision: item.recordRevision + 1 };
    expect(() => assertQueueItemTransition(item, changedPrompt)).toThrow(/cannot change/i);

    const historical = { ...item, state: 'historical' as const, runRevision: IDS[2] };
    expect(() => assertQueueItemTransition(historical, {
      ...historical,
      recordRevision: historical.recordRevision + 1,
    })).toThrow(/immutable/i);
  });

  it('does not permit an early or extended one-time snooze', () => {
    const snoozed = {
      eventId: `queue-complete:${IDS[2]}`,
      runRevision: IDS[2],
      state: 'snoozed' as const,
      kind: 'complete' as const,
      snoozeUsed: true,
      snoozeDueAt: LATER,
      notificationDisposition: 'delivered' as const,
      snoozeNotificationDisposition: null,
    };
    expect(() => assertQueueAlarmTransition(snoozed, {
      ...snoozed,
      state: 'ringing',
      snoozeDueAt: null,
      snoozeNotificationDisposition: 'pending',
    }, new Date(NOW).valueOf())).toThrow(/before its due time/i);
    expect(() => assertQueueAlarmTransition(snoozed, {
      ...snoozed,
      snoozeDueAt: '2026-08-03T12:16:00.000Z',
    }, new Date(NOW).valueOf())).toThrow(/extend/i);
    expect(() => assertQueueAlarmTransition(snoozed, {
      ...snoozed,
      state: 'ringing',
      snoozeDueAt: null,
      snoozeNotificationDisposition: 'pending',
    }, new Date(LATER).valueOf())).not.toThrow();
  });
});
