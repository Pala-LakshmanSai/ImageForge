import { beforeEach, describe, expect, it, vi } from 'vitest';
import vectorsJson from '../../contracts/gpu-pod-control-v1.vectors.json';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  nativeGpuNormalStop,
  nativeGpuNormalStopLoad,
  nativeGpuPodObserve,
  parseNativeGpuNormalStopResultV1,
  parseNativeGpuNormalStopV1,
  parseNativeGpuPodObservationV1,
  type NativeGpuNormalStopV1,
} from './gpuPodBridge';

type VectorKind = 'podObservation' | 'normalStopInput' | 'normalStopResult';
interface AcceptedVector {
  id: string;
  kind: VectorKind;
  value: unknown;
  canonicalJson: string;
}
interface RejectedVector {
  id: string;
  kind: VectorKind;
  input?: unknown;
  value: unknown;
  reason: string;
}

const vectors = vectorsJson as unknown as {
  accepted: AcceptedVector[];
  rejected: RejectedVector[];
  lifecycleRevisionTransitions: Array<Record<string, unknown>>;
  normalStopProviderCases: Array<Record<string, unknown>>;
  normalStopReplayCases: Array<Record<string, unknown>>;
  normalStopLoadCases: Array<Record<string, unknown>>;
};

function parse(kind: VectorKind, value: unknown): unknown {
  if (kind === 'podObservation') return parseNativeGpuPodObservationV1(value);
  if (kind === 'normalStopInput') return parseNativeGpuNormalStopV1(value);
  return parseNativeGpuNormalStopResultV1(value);
}

describe('native GPU Pod control bridge', () => {
  beforeEach(() => invoke.mockReset());

  it('accepts every shared structural/relation vector and preserves canonical bytes', () => {
    for (const vector of vectors.accepted) {
      expect(parse(vector.kind, vector.value), vector.id).not.toBeNull();
      expect(JSON.stringify(vector.value), vector.id).toBe(vector.canonicalJson);
    }
  });

  it('rejects every shared malformed or impossible vector', async () => {
    for (const vector of vectors.rejected) {
      if (vector.reason === 'input_result_pod_mismatch') {
        invoke.mockResolvedValueOnce(vector.value);
        await expect(nativeGpuNormalStop(vector.input as NativeGpuNormalStopV1), vector.id)
          .rejects.toThrow('invalid strict result');
        continue;
      }
      expect(parse(vector.kind, vector.value), vector.id).toBeNull();
    }
  });

  it('binds revision/exhaustion and replay cases in the checked-in semantic fixture', () => {
    expect(vectors.lifecycleRevisionTransitions).toContainEqual(expect.objectContaining({
      id: 'coalesced_success',
      callerCount: 3,
      providerListCount: 1,
      allCallersSameBytes: true,
    }));
    expect(vectors.lifecycleRevisionTransitions).toContainEqual(expect.objectContaining({
      id: 'revision_exhausted',
      nextRevision: Number.MAX_SAFE_INTEGER,
      providerListCount: 0,
    }));
    expect(vectors.lifecycleRevisionTransitions).toContainEqual(expect.objectContaining({
      id: 'normal_stop_revision_exhausted_max_minus_one',
      providerListCount: 0,
      providerDeleteCount: 0,
      workerFinalizeCount: 0,
      journalWriteCount: 0,
    }));
    expect(vectors.normalStopProviderCases).toContainEqual(expect.objectContaining({
      id: 'delete_404_plus_absence_peer_remains_visible',
      expectedDisposition: 'already_stopped',
      postListPodIds: ['pod-peer-2'],
      providerDeleteCount: 1,
    }));
    expect(vectors.normalStopProviderCases).toContainEqual(expect.objectContaining({
      id: 'delete_404_post_list_still_contains_old',
      expectedDisposition: 'delete_uncertain',
      expectedIssueCode: 'gpu_stop_delete_uncertain',
    }));
    expect(vectors.normalStopReplayCases).toContainEqual(expect.objectContaining({
      id: 'uncertain_same_request_relaunch',
      sameDurableOperationId: true,
      returnedObservationProcessEpoch: 'current',
      returnedObservationRevision: 'current+1',
      oldPodRetained: true,
      replaceCurrentProjection: true,
      providerDeleteCount: 0,
      workerFinalizeCount: 0,
    }));
    expect(vectors.normalStopReplayCases).toContainEqual(expect.objectContaining({
      id: 'completed_exact_replay',
      expectedByteIdentical: true,
      replaceCurrentProjection: false,
      requiresCurrentObserveBeforeLifecycle: true,
    }));
    expect(vectors.normalStopLoadCases).toContainEqual(expect.objectContaining({
      id: 'active_delete_uncertain_relaunch',
      expectedInput: 'byte_identical_persisted_input',
      providerDeleteCount: 0,
      workerCallCount: 0,
    }));
    expect(vectors.normalStopLoadCases).toContainEqual(expect.objectContaining({
      id: 'preflight_only_does_not_resume',
      expectedInput: null,
      providerDeleteCount: 0,
    }));
  });

  it('invokes only the three narrow commands with strict inputs and outputs', async () => {
    const observation = vectors.accepted.find((vector) => vector.id === 'single_observation')!;
    invoke.mockResolvedValueOnce(observation.value);
    await expect(nativeGpuPodObserve()).resolves.toEqual(parseNativeGpuPodObservationV1(observation.value));
    expect(invoke).toHaveBeenLastCalledWith('gpu_pod_observe');

    const input = vectors.accepted.find((vector) => vector.id === 'normal_stop_input')!;
    invoke.mockResolvedValueOnce(input.value);
    await expect(nativeGpuNormalStopLoad())
      .resolves.toEqual(parseNativeGpuNormalStopV1(input.value));
    expect(invoke).toHaveBeenLastCalledWith('gpu_normal_stop_load');

    const result = vectors.accepted.find((vector) => vector.id === 'normal_stop_success')!;
    invoke.mockResolvedValueOnce(result.value);
    await expect(nativeGpuNormalStop(input.value as NativeGpuNormalStopV1))
      .resolves.toEqual(parseNativeGpuNormalStopResultV1(result.value));
    expect(invoke).toHaveBeenLastCalledWith('gpu_normal_stop', { input: input.value });
  });

  it('rejects invalid input before invoke and unknown native output fields', async () => {
    const input = vectors.accepted.find((vector) => vector.id === 'normal_stop_input')!;
    await expect(nativeGpuNormalStop({
      ...(input.value as NativeGpuNormalStopV1),
      expectedLifecycleRevision: -1,
    })).rejects.toThrow('input is invalid');
    expect(invoke).not.toHaveBeenCalled();

    const observation = vectors.accepted.find((vector) => vector.id === 'offline_observation')!;
    invoke.mockResolvedValueOnce({ ...(observation.value as object), rawProviderBody: {} });
    await expect(nativeGpuPodObserve()).rejects.toThrow('invalid strict result');

    invoke.mockResolvedValueOnce({ ...(input.value as object), finalizationId: crypto.randomUUID() });
    await expect(nativeGpuNormalStopLoad()).rejects.toThrow('invalid strict input');
  });
});
