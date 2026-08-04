import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createConfiguredInitialState } from '../domain/reducer';
import type { NativeQueueItemPlaceholderV1, NativeQueueItemV1 } from '../domain/queue';
import { QueueRail } from './QueueRail';

const NOW = '2026-08-03T12:00:00.000Z';

function uuid(index: number, variant = '8') {
  return `00000000-0000-4000-${variant}000-${index.toString(16).padStart(12, '0')}`;
}

function item(index: number, state: NativeQueueItemV1['state'] = 'staged'): NativeQueueItemV1 {
  return {
    schemaVersion: 1,
    queueItemId: uuid(index),
    clientSubmissionId: uuid(index + 1_000, '9'),
    recordRevision: 1,
    runRevision: state === 'staged' ? null : uuid(9_000),
    remoteBatchId: ['active', 'saving', 'completed', 'completed_with_failures', 'interrupted'].includes(state) ? uuid(index + 2_000) : null,
    state,
    attentionCode: ['needs_attention', 'interrupted'].includes(state) ? 'queue_test_attention' : null,
    name: `Batch ${index + 1}`,
    prompts: ['A documentary frame'],
    baseSeed: 100_000 + index,
    destination: '/safe/imageforge-output',
    aspectRatio: '16:9',
    styleSuffix: null,
    references: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('QueueRail', () => {
  it('mounts a bounded window for 450 queue rows', () => {
    const state = createConfiguredInitialState();
    state.queue = {
      ...state.queue,
      loadState: 'ready',
      document: { schemaVersion: 1, items: Array.from({ length: 450 }, (_, index) => item(index)), run: null, alarm: null },
    };
    const { container } = render(<QueueRail state={state} dispatch={vi.fn()} />);
    expect(container.querySelectorAll('.queue-row').length).toBeLessThanOrEqual(40);
    expect(screen.getByLabelText('450 local queue batches')).toBeInTheDocument();
  });

  it('does not enable Run queue for a ready phase without an exact Pod identity', () => {
    const state = createConfiguredInitialState();
    state.pod = { ...state.pod, phase: 'ready', podId: null, gpu: 'RTX 4090', health: 'degraded' };
    state.queue = {
      ...state.queue,
      loadState: 'ready',
      document: { schemaVersion: 1, items: [item(1)], run: null, alarm: null },
    };

    render(<QueueRail state={state} dispatch={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Run queue' })).toBeDisabled();
  });

  it('does not enable Resume queue without an exact ready Pod identity', () => {
    const state = createConfiguredInitialState();
    const runRevision = uuid(9_001);
    state.pod = { ...state.pod, phase: 'ready', podId: null, gpu: 'RTX 4090', health: 'degraded' };
    state.queue = {
      ...state.queue,
      loadState: 'ready',
      document: {
        schemaVersion: 1,
        items: [item(1)],
        run: { runRevision, cohortItemIds: [item(1).queueItemId], runnerState: 'paused', authorizationRequired: true, keepAwake: false },
        alarm: null,
      },
    };

    render(<QueueRail state={state} dispatch={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Resume queue' })).toBeDisabled();
  });

  it('offers an explicit reset confirmation entry only for an unrecoverable store', () => {
    const dispatch = vi.fn();
    const state = createConfiguredInitialState();
    state.queue = {
      ...state.queue,
      loadState: 'error',
      issues: [{ code: 'queue_store_unrecoverable', queueItemId: null, retryable: false }],
    };
    render(<QueueRail state={state} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset local queue…' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'REQUEST_RESET_QUEUE' });
  });

  it('labels corrupt-record removal as an explicit repair action', () => {
    const dispatch = vi.fn();
    const placeholder: NativeQueueItemPlaceholderV1 = {
      schemaVersion: 1,
      queueItemId: uuid(1),
      recordRevision: 3,
      state: 'needs_attention',
      attentionCode: 'queue_item_corrupt',
      name: 'Recovered summary',
      promptCount: 42,
      referenceCount: 2,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const state = createConfiguredInitialState();
    state.queue = {
      ...state.queue,
      loadState: 'ready',
      document: { schemaVersion: 1, items: [placeholder], run: null, alarm: null },
    };
    render(<QueueRail state={state} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove corrupt item Recovered summary' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_QUEUE_ITEM', queueItemId: placeholder.queueItemId });
  });

  it('offers removal, but not editing, for an item whose copied reference is damaged', () => {
    const dispatch = vi.fn();
    const damaged = {
      ...item(1, 'needs_attention'),
      runRevision: null,
      remoteBatchId: null,
      attentionCode: 'queue_reference_missing',
    };
    const state = createConfiguredInitialState();
    state.queue = {
      ...state.queue,
      loadState: 'ready',
      document: { schemaVersion: 1, items: [damaged], run: null, alarm: null },
    };
    render(<QueueRail state={state} dispatch={dispatch} />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove damaged item Batch 2' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_QUEUE_ITEM', queueItemId: damaged.queueItemId });
  });

  it('exposes Clear history only after the completed event is acknowledged', () => {
    const dispatch = vi.fn();
    const historical = item(1, 'historical');
    const runRevision = historical.runRevision!;
    const state = createConfiguredInitialState();
    state.queue = {
      ...state.queue,
      loadState: 'ready',
      document: {
        schemaVersion: 1,
        items: [historical],
        run: { runRevision, cohortItemIds: [historical.queueItemId], runnerState: 'completed', authorizationRequired: true, keepAwake: false },
        alarm: {
          eventId: `queue-complete:${runRevision}`,
          runRevision,
          state: 'acknowledged',
          kind: 'complete',
          snoozeUsed: false,
          snoozeDueAt: null,
          notificationDisposition: 'delivered',
          snoozeNotificationDisposition: null,
        },
      },
    };
    render(<QueueRail state={state} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'CLEAR_QUEUE_HISTORY' });
  });

  it('uses the next-run keep-awake preference after the prior run completes', () => {
    const dispatch = vi.fn();
    const historical = item(1, 'historical');
    const next = item(2, 'staged');
    const runRevision = historical.runRevision!;
    const state = createConfiguredInitialState();
    state.queue = {
      ...state.queue,
      loadState: 'ready',
      keepAwakePreference: true,
      document: {
        schemaVersion: 1,
        items: [historical, next],
        run: { runRevision, cohortItemIds: [historical.queueItemId], runnerState: 'completed', authorizationRequired: true, keepAwake: false },
        alarm: {
          eventId: `queue-complete:${runRevision}`,
          runRevision,
          state: 'acknowledged',
          kind: 'complete',
          snoozeUsed: false,
          snoozeDueAt: null,
          notificationDisposition: 'delivered',
          snoozeNotificationDisposition: null,
        },
      },
    };
    render(<QueueRail state={state} dispatch={dispatch} />);
    const checkbox = screen.getByRole('checkbox', { name: /Keep this computer awake/i });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_QUEUE_KEEP_AWAKE', enabled: false });
  });

  it('keeps a snoozed completion explicit while the GPU remains running', () => {
    const completed = item(1, 'completed_with_failures');
    const runRevision = completed.runRevision!;
    const state = createConfiguredInitialState();
    state.pod = {
      ...state.pod,
      phase: 'ready',
      podId: 'pod-queue-active',
      matchingPodIds: ['pod-queue-active'],
      gpu: 'RTX 4090',
    };
    state.queue = {
      ...state.queue,
      loadState: 'ready',
      document: {
        schemaVersion: 1,
        items: [completed],
        run: { runRevision, cohortItemIds: [completed.queueItemId], runnerState: 'completed', authorizationRequired: true, keepAwake: false },
        alarm: {
          eventId: `queue-attention:${runRevision}`,
          runRevision,
          state: 'snoozed',
          kind: 'attention',
          snoozeUsed: true,
          snoozeDueAt: '2026-08-03T12:15:00.000Z',
          notificationDisposition: 'delivered',
          snoozeNotificationDisposition: 'pending',
        },
      },
    };

    render(<QueueRail state={state} dispatch={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveClass('queue-alarm-card--snoozed');
    expect(screen.getByText('Alarm snoozed')).toBeInTheDocument();
    expect(screen.getByText('It will ring once more after 15 minutes. The GPU is still running.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss alarm' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop GPU…' })).toBeEnabled();
  });

  it('keeps Stop available when queue alarm rings and Pod health is degraded', () => {
    const completed = item(1, 'completed');
    const runRevision = completed.runRevision!;
    const state = createConfiguredInitialState();
    state.pod = {
      ...state.pod,
      phase: 'error',
      health: 'degraded',
      podId: 'pod-still-billed',
      matchingPodIds: ['pod-still-billed'],
      gpu: 'RTX 4090',
    };
    state.queue = {
      ...state.queue,
      loadState: 'ready',
      document: {
        schemaVersion: 1,
        items: [completed],
        run: { runRevision, cohortItemIds: [completed.queueItemId], runnerState: 'completed', authorizationRequired: true, keepAwake: false },
        alarm: {
          eventId: `queue-complete:${runRevision}`,
          runRevision,
          state: 'ringing',
          kind: 'complete',
          snoozeUsed: false,
          snoozeDueAt: null,
          notificationDisposition: 'delivered',
          snoozeNotificationDisposition: null,
        },
      },
    };

    render(<QueueRail state={state} dispatch={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Stop GPU…' })).toBeEnabled();
  });

  it.each(['permission_denied', 'failed'] as const)('keeps the in-app alarm fallback visible for an authoritative %s disposition even when OS permission is granted', (disposition) => {
    const completed = item(1, 'completed');
    const runRevision = completed.runRevision!;
    const state = createConfiguredInitialState();
    state.queue = {
      ...state.queue,
      loadState: 'ready',
      notificationPermission: 'granted',
      document: {
        schemaVersion: 1,
        items: [completed],
        run: { runRevision, cohortItemIds: [completed.queueItemId], runnerState: 'completed', authorizationRequired: true, keepAwake: false },
        alarm: {
          eventId: `queue-complete:${runRevision}`,
          runRevision,
          state: 'ringing',
          kind: 'complete',
          snoozeUsed: false,
          snoozeDueAt: null,
          notificationDisposition: disposition,
          snoozeNotificationDisposition: null,
        },
      },
    };

    render(<QueueRail state={state} dispatch={vi.fn()} />);
    expect(screen.getByText('In-app fallback stays visible')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Queue complete');
  });

  it('locks assigned staged-row edits until this process owns the run lease', () => {
    const dispatch = vi.fn();
    const assigned = { ...item(1), runRevision: uuid(9_000), recordRevision: 2 };
    const state = createConfiguredInitialState();
    state.queue = {
      ...state.queue,
      loadState: 'ready',
      document: {
        schemaVersion: 1,
        items: [assigned],
        run: {
          runRevision: assigned.runRevision!,
          cohortItemIds: [assigned.queueItemId],
          runnerState: 'paused',
          authorizationRequired: true,
          keepAwake: false,
        },
        alarm: {
          eventId: `queue-complete:${assigned.runRevision}`,
          runRevision: assigned.runRevision!,
          state: 'disarmed',
          kind: null,
          snoozeUsed: false,
          snoozeDueAt: null,
          notificationDisposition: null,
          snoozeNotificationDisposition: null,
        },
      },
      lease: null,
    };
    const { rerender } = render(<QueueRail state={state} dispatch={dispatch} />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Batch 2' })).toBeDisabled();

    const owned = { ...state, queue: { ...state.queue, lease: { runRevision: assigned.runRevision!, held: true } } };
    rerender(<QueueRail state={owned} dispatch={dispatch} />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove Batch 2' })).toBeEnabled();
  });
});
