import {
  assertQueueAlarmTransition,
  assertQueueItemTransition,
  assertQueueRunTransition,
  createEmptyQueueSnapshot,
  isCanonicalQueueUuid,
  isQueueEventId,
  isQueueLocallyRemovableIssue,
  isQueuePlaceholder,
  parseNativeQueueSnapshot,
  type NativeAlertInput,
  type NativeAlertResult,
  type NativePowerInput,
  type NativePowerState,
  type NativeQueueCommitV1,
  type NativeQueueDispatchPayloadV1,
  type NativeQueueItemKey,
  type NativeQueueReferenceV1,
  type NativeQueueResetV1,
  type NativeQueueSnapshotV1,
  type NativeReferenceBlobV1,
  type NativeRunKey,
  type NativeRunnerLease,
  type QueueHostPort,
  type QueueNotificationDisposition,
} from '../domain/queue';
import { validateReferenceBytes } from '../domain/references';
import type { BatchReference } from '../domain/types';

export class QueueStoreError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'QueueStoreError';
    this.code = code;
    this.retryable = retryable;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function sha256Hex(bytes: readonly number[]): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new QueueStoreError('queue_hash_unavailable', 'Secure reference hashing is unavailable.');
  const input = Uint8Array.from(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function snapshotQueueReferences(
  references: readonly BatchReference[],
  uuid: () => string = () => crypto.randomUUID(),
): Promise<Array<{ metadata: NativeQueueReferenceV1; blob: NativeReferenceBlobV1 }>> {
  const result: Array<{ metadata: NativeQueueReferenceV1; blob: NativeReferenceBlobV1 }> = [];
  for (const reference of references) {
    const id = uuid();
    if (!isCanonicalQueueUuid(id)) throw new QueueStoreError('queue_reference_invalid', 'A queue reference ID is invalid.');
    const validation = validateReferenceBytes(reference.mimeType, reference.bytes);
    if (validation !== null || reference.sizeBytes !== reference.bytes.length) {
      throw new QueueStoreError('queue_reference_invalid', 'A reference image is no longer valid.');
    }
    const sha256 = await sha256Hex(reference.bytes);
    result.push({
      metadata: {
        id,
        name: reference.name,
        mimeType: reference.mimeType,
        sizeBytes: reference.bytes.length,
        sha256,
      },
      blob: {
        sha256,
        mimeType: reference.mimeType,
        sizeBytes: reference.bytes.length,
        bytes: [...reference.bytes],
      },
    });
  }
  return result;
}

function platform(): NativePowerState['platform'] {
  return typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent) ? 'windows' : 'macos';
}

export interface MemoryQueueHostOptions {
  deliverAlert?: (
    input: NativeAlertInput,
  ) => Exclude<QueueNotificationDisposition, 'pending'> | Promise<Exclude<QueueNotificationDisposition, 'pending'>>;
  now?: () => number;
}

export async function queueNotificationId(eventId: string, kind: NativeAlertInput['kind']): Promise<number> {
  const source = kind === 'snooze' ? `${eventId}:snooze` : eventId;
  const digest = await sha256Hex([...new TextEncoder().encode(source)]);
  const raw = Number.parseInt(digest.slice(0, 8), 16) & 0x7fffffff;
  return raw === 0 ? 1 : raw;
}

/** Deterministic fake with the same optimistic revision and no-generic-path
 * semantics as the native host. It is used only by tests and the preview app. */
export function createMemoryQueueHost(
  initial = createEmptyQueueSnapshot(),
  options: MemoryQueueHostOptions = {},
): QueueHostPort {
  let snapshot = parseNativeQueueSnapshot(clone(initial));
  const blobs = new Map<string, NativeReferenceBlobV1>();
  let lease: NativeRunnerLease | null = null;
  let power: NativePowerState = { runRevision: null, active: false, platform: platform(), displaySleepAllowed: true };
  const outbox = new Map<string, Exclude<QueueNotificationDisposition, 'pending'>>();
  let permissionGranted = true;

  return {
    async load() {
      return clone(snapshot);
    },
    async reset(_input: NativeQueueResetV1) {
      throw new QueueStoreError('queue_reset_not_allowed', 'The local queue is healthy and cannot be reset.');
    },
    async commit(input: NativeQueueCommitV1) {
      if (input.expectedRevision !== snapshot.storeRevision) {
        throw new QueueStoreError('queue_revision_conflict', 'The local queue changed in another window. Reload it before editing.');
      }
      const pendingBlobs = new Map<string, NativeReferenceBlobV1>();
      for (const blob of input.referenceBlobs) {
        if (blob.sizeBytes !== blob.bytes.length || await sha256Hex(blob.bytes) !== blob.sha256) {
          throw new QueueStoreError('queue_reference_mismatch', 'A copied queue reference failed checksum validation.');
        }
        if (validateReferenceBytes(blob.mimeType, blob.bytes) !== null) {
          throw new QueueStoreError('queue_reference_mismatch', 'A copied queue reference is not a valid image.');
        }
        if (pendingBlobs.has(blob.sha256)) {
          throw new QueueStoreError('queue_commit_invalid', 'A copied queue reference was supplied more than once.');
        }
        pendingBlobs.set(blob.sha256, clone(blob));
      }
      let candidate: NativeQueueSnapshotV1;
      try {
        candidate = parseNativeQueueSnapshot({
          schemaVersion: 1,
          storeRevision: snapshot.storeRevision + 1,
          document: clone(input.document),
          issues: [],
        });
        const previousRows = new Map(snapshot.document.items.map((row) => [row.queueItemId, row]));
        const nextRows = new Map(candidate.document.items.map((row) => [row.queueItemId, row]));
        for (const [id, next] of nextRows) {
          const previous = previousRows.get(id);
          if (previous === undefined) {
            if (isQueuePlaceholder(next)) {
              throw new Error('A corrupt placeholder cannot be introduced by a renderer commit.');
            }
            const assignedToNewPausedRun = snapshot.document.run === null
              && candidate.document.run?.runnerState === 'paused'
              && candidate.document.run.authorizationRequired
              && next.runRevision === candidate.document.run.runRevision
              && candidate.document.run.cohortItemIds.includes(id);
            const validInitialRevision = next.runRevision === null
              ? next.recordRevision === 1
              : assignedToNewPausedRun && next.recordRevision === 2;
            if (
              !validInitialRevision
              || next.state !== 'staged'
              || (next.runRevision !== null && !assignedToNewPausedRun)
            ) {
              throw new Error('A new queue item must be revision one and unassigned, or revision two in the newly paused run.');
            }
          } else if (JSON.stringify(previous) !== JSON.stringify(next)) {
            if (isQueuePlaceholder(previous) || isQueuePlaceholder(next)) throw new Error('A corrupt placeholder can only be retained or removed.');
            assertQueueItemTransition(previous, next);
            if (previous.state === 'staged' && next.state === 'dispatching') {
              const run = candidate.document.run;
              if (
                run === null
                || run.runRevision !== next.runRevision
                || run.runnerState !== 'running'
                || run.authorizationRequired
                || lease?.runRevision !== run.runRevision
                || !run.cohortItemIds.includes(id)
              ) {
                throw new QueueStoreError('queue_runner_busy', 'Dispatch requires the exact authorized running queue lease.');
              }
            }
            if (
              next.state === 'historical'
              && previous.state !== 'historical'
              && (
                candidate.document.run?.runnerState !== 'completed'
                || candidate.document.alarm?.state !== 'acknowledged'
              )
            ) {
              throw new Error('A terminal queue row can be archived only after its completion event is acknowledged.');
            }
          }
        }
        const positionLocked = new Set(['dispatching', 'active', 'saving', 'historical']);
        snapshot.document.items.forEach((previous, index) => {
          if (!positionLocked.has(previous.state) || !nextRows.has(previous.queueItemId)) return;
          if (candidate.document.items[index]?.queueItemId !== previous.queueItemId) {
            throw new Error('A progressed or historical queue row cannot move.');
          }
        });
        for (const [id, previous] of previousRows) {
          if (nextRows.has(id)) continue;
          const removable = isQueuePlaceholder(previous)
            || (previous.state === 'staged' && previous.runRevision === null)
            || (
              previous.state === 'needs_attention'
              && previous.runRevision === null
              && [
                'queue_reference_missing',
                'queue_reference_mismatch',
                'queue_destination_unavailable',
              ].includes(previous.attentionCode ?? '')
            )
            || (
              previous.state === 'historical'
              && snapshot.document.run?.runnerState === 'completed'
              && snapshot.document.alarm?.state === 'acknowledged'
            );
          if (!removable) throw new Error('The queue item is locked by its current run.');
        }
        const previousRun = snapshot.document.run;
        const nextRun = candidate.document.run;
        if (previousRun === null && nextRun !== null) {
          if (nextRun.runnerState !== 'paused' || !nextRun.authorizationRequired) {
            throw new Error('A new queue run must be durably paused before lease acquisition.');
          }
        } else if (previousRun !== null && nextRun !== null && previousRun.runRevision === nextRun.runRevision) {
          if (JSON.stringify(previousRun) !== JSON.stringify(nextRun)) {
            assertQueueRunTransition(previousRun, nextRun, candidate.document);
          }
        } else if (previousRun !== null && nextRun !== null) {
          if (
            previousRun.runnerState !== 'completed'
            || snapshot.document.alarm?.state !== 'acknowledged'
            || nextRun.runnerState !== 'paused'
            || !nextRun.authorizationRequired
          ) throw new Error('The singular queue run cannot be replaced yet.');
        } else if (previousRun !== null && nextRun === null) {
          if (previousRun.runnerState !== 'completed' || snapshot.document.alarm?.state !== 'acknowledged') {
            throw new Error('Only acknowledged completed history may clear the current run.');
          }
        }

        const previousAlarm = snapshot.document.alarm;
        const nextAlarm = candidate.document.alarm;
        if (
          previousAlarm !== null
          && nextAlarm !== null
          && previousAlarm.runRevision === nextAlarm.runRevision
          && JSON.stringify(previousAlarm) !== JSON.stringify(nextAlarm)
        ) {
          assertQueueAlarmTransition(previousAlarm, nextAlarm, options.now?.() ?? Date.now());
          const assertOutbox = (
            previous: QueueNotificationDisposition | null,
            next: QueueNotificationDisposition | null,
            kind: NativeAlertInput['kind'],
          ) => {
            if (previous === next || next === null || next === 'pending') return;
            if (outbox.get(`${nextAlarm.eventId}:${kind}`) !== next) {
              throw new Error('A queue notification result must match its native outbox.');
            }
          };
          if (nextAlarm.kind !== null) {
            assertOutbox(previousAlarm.notificationDisposition, nextAlarm.notificationDisposition, nextAlarm.kind);
          }
          assertOutbox(previousAlarm.snoozeNotificationDisposition, nextAlarm.snoozeNotificationDisposition, 'snooze');
        }

        if (previousRun !== null && previousRun.runnerState !== 'completed') {
          const currentRowsChanged = previousRun.cohortItemIds.some((id) => (
            JSON.stringify(previousRows.get(id)) !== JSON.stringify(nextRows.get(id))
          ));
          const runChanged = JSON.stringify(previousRun) !== JSON.stringify(nextRun);
          const alarmChanged = JSON.stringify(snapshot.document.alarm) !== JSON.stringify(candidate.document.alarm);
          if ((currentRowsChanged || runChanged || alarmChanged) && lease?.runRevision !== previousRun.runRevision) {
            throw new QueueStoreError('queue_runner_busy', 'Only the active local runner may mutate its current run.');
          }
        }
        for (const row of candidate.document.items) {
          if (isQueuePlaceholder(row)) continue;
          const previous = previousRows.get(row.queueItemId);
          if (
            row.state === 'cancelled'
            && previous !== undefined
            && isQueueLocallyRemovableIssue(previous)
          ) continue;
          for (const reference of row.references) {
            const blob = pendingBlobs.get(reference.sha256) ?? blobs.get(reference.sha256);
            if (
              blob === undefined
              || blob.sizeBytes !== reference.sizeBytes
              || blob.mimeType !== reference.mimeType
            ) {
              throw new QueueStoreError('queue_reference_missing', 'A copied queue reference is missing from this device.');
            }
          }
        }
      } catch (error) {
        if (error instanceof QueueStoreError) throw error;
        throw new QueueStoreError('queue_commit_invalid', error instanceof Error ? error.message : 'The queue mutation is invalid.');
      }
      for (const [sha256, blob] of pendingBlobs) blobs.set(sha256, blob);
      snapshot = candidate;
      return clone(snapshot);
    },
    async prepareDispatch(input: NativeQueueItemKey): Promise<NativeQueueDispatchPayloadV1> {
      if (!['edit', 'dispatch'].includes(input.purpose)) {
        throw new QueueStoreError('queue_item_not_dispatchable', 'The queue read purpose is invalid.');
      }
      const row = snapshot.document.items.find((item) => item.queueItemId === input.queueItemId);
      if (row === undefined || isQueuePlaceholder(row) || row.clientSubmissionId !== input.clientSubmissionId) {
        throw new QueueStoreError('queue_item_not_found', 'The staged queue item could not be prepared.');
      }
      if (row.state !== 'staged') throw new QueueStoreError('queue_item_not_dispatchable', 'Only a staged queue batch can be opened or dispatched.');
      const run = snapshot.document.run;
      if (input.purpose === 'dispatch') {
        if (row.runRevision === null || lease?.runRevision !== row.runRevision) {
          throw new QueueStoreError('queue_runner_busy', 'Another ImageForge process owns the local queue runner.');
        }
        if (run?.runRevision !== row.runRevision || run.runnerState !== 'running' || run.authorizationRequired) {
          throw new QueueStoreError('queue_item_not_dispatchable', 'Only a staged batch in the running local queue can be dispatched.');
        }
      } else if (
        row.runRevision !== null
        && (run?.runRevision !== row.runRevision || lease?.runRevision !== row.runRevision || run.runnerState === 'completed')
      ) {
        throw new QueueStoreError('queue_runner_busy', 'Editing an assigned staged batch requires its current local runner lease.');
      }
      const references = row.references.map((reference) => {
        const blob = blobs.get(reference.sha256);
        if (blob === undefined) throw new QueueStoreError('queue_reference_missing', 'A copied queue reference is missing.');
        if (blob.sizeBytes !== reference.sizeBytes || blob.mimeType !== reference.mimeType) {
          throw new QueueStoreError('queue_reference_mismatch', 'A copied queue reference changed.');
        }
        return { ...reference, bytes: [...blob.bytes] };
      });
      return {
        queueItemId: row.queueItemId,
        clientSubmissionId: row.clientSubmissionId,
        name: row.name,
        prompts: [...row.prompts],
        baseSeed: row.baseSeed,
        destination: row.destination,
        aspectRatio: row.aspectRatio,
        references,
      };
    },
    async acquireRunner(input: NativeRunKey) {
      if (!isCanonicalQueueUuid(input.runRevision)) throw new QueueStoreError('queue_run_invalid', 'The queue run ID is invalid.');
      const run = snapshot.document.run;
      if (run?.runRevision !== input.runRevision) {
        throw new QueueStoreError('queue_runner_busy', 'The requested local queue run is not the durable current run.');
      }
      if (lease?.runRevision === input.runRevision) return { ...lease };
      if (lease !== null) {
        throw new QueueStoreError('queue_runner_busy', 'Another ImageForge process is running this device queue.');
      }
      if (!['paused', 'needs_attention'].includes(run.runnerState) || !run.authorizationRequired) {
        throw new QueueStoreError('queue_runner_busy', 'Only a paused local queue can acquire a new runner lease.');
      }
      lease = { runRevision: input.runRevision, held: true };
      return { ...lease };
    },
    async releaseRunner(input: NativeRunKey) {
      if (lease?.runRevision !== input.runRevision) {
        throw new QueueStoreError('queue_runner_busy', 'This process does not own the requested local queue run.');
      }
      lease = null;
      if (power.runRevision === input.runRevision) power = { ...power, runRevision: null, active: false };
      return { runRevision: input.runRevision, held: false };
    },
    async setSleepPrevention(input: NativePowerInput) {
      if (input.enabled && lease?.runRevision !== input.runRevision) {
        throw new QueueStoreError('queue_runner_busy', 'Keep-awake requires the active local queue lease.');
      }
      const run = snapshot.document.run;
      if (
        input.enabled
        && (
          run?.runRevision !== input.runRevision
          || !['running', 'pause_after_current'].includes(run.runnerState)
          || run.authorizationRequired
        )
      ) {
        throw new QueueStoreError('queue_runner_busy', 'Keep-awake requires the authorized running local queue.');
      }
      power = {
        runRevision: input.enabled ? input.runRevision : null,
        active: input.enabled,
        platform: platform(),
        displaySleepAllowed: true,
      };
      return { ...power };
    },
    async signalAlert(input: NativeAlertInput): Promise<NativeAlertResult> {
      if (!isQueueEventId(input.eventId) || !['complete', 'attention', 'snooze'].includes(input.kind)) {
        throw new QueueStoreError('queue_alert_event_invalid', 'The queue alert event is invalid.');
      }
      const current = snapshot.document.alarm;
      if (
        current === null
        || current.eventId !== input.eventId
        || current.state !== 'ringing'
        || (input.kind === 'snooze' ? !current.snoozeUsed : current.kind !== input.kind)
      ) throw new QueueStoreError('queue_alert_event_invalid', 'The completion alert is no longer current.');
      const key = `${input.eventId}:${input.kind}`;
      const already = outbox.get(key) === 'delivered';
      const disposition = already
        ? 'delivered'
        : await (options.deliverAlert?.(input) ?? (permissionGranted ? 'delivered' : 'permission_denied'));
      if (!already) outbox.set(key, disposition);
      return {
        eventId: input.eventId,
        notificationId: await queueNotificationId(input.eventId, input.kind),
        disposition: already ? 'already_delivered' : disposition,
      };
    },
    async isNotificationPermissionGranted() {
      return permissionGranted;
    },
    async requestNotificationPermission() {
      permissionGranted = true;
      return 'granted';
    },
  };
}
