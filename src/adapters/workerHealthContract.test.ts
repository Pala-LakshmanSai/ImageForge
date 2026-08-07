// Node types are referenced only here. The renderer's tsconfig deliberately
// omits them so app code stays browser-targeted; this contract guard is a
// build-time check that reads the worker's source, so it needs them locally.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpWorkerHealthProbe, deriveRunPodProxyUrl } from '@imageforge/runpod-client';
import type { FetchTransport } from '@imageforge/runpod-client';

/**
 * The desktop health probe pins the worker's version and model identity as an
 * exact contract: any mismatch is rejected as `api_response_invalid`, which the
 * lifecycle latches into a terminal `error` phase after its grace window. That
 * means shipping a new worker image without moving the desktop's expected
 * version bricks a perfectly healthy Pod, and no amount of polling recovers it.
 *
 * The previous fixtures hardcoded the version literal on both sides, so they
 * agreed with each other while disagreeing with the worker actually running.
 * These tests instead read the worker's own constants, so the suite fails the
 * moment the two drift.
 */

const CONSTANTS_PATH = resolve(process.cwd(), 'worker/src/imageforge_worker/constants.py');

function workerConstant(name: string): string {
  const source = readFileSync(CONSTANTS_PATH, 'utf8');
  const match = new RegExp(`^${name}:\\s*Final\\s*=\\s*"([^"]+)"`, 'm').exec(source);
  if (match === null) {
    throw new Error(`Worker constant ${name} was not found in ${CONSTANTS_PATH}`);
  }
  return match[1];
}

/** The exact shape `GET /v1/health` returns from a warm worker. */
function readyHealthPayload(): Record<string, unknown> {
  return {
    schema_version: 1,
    service: 'imageforge-worker',
    version: workerConstant('WORKER_VERSION'),
    process: { status: 'ok', uptime_ms: 664616.858 },
    model: {
      id: workerConstant('MODEL_ID'),
      revision: workerConstant('MODEL_REVISION'),
      precision: workerConstant('MODEL_PRECISION'),
      status: 'ready',
    },
    gpu: {
      state: 'ready',
      available: true,
      approved: true,
      name: 'NVIDIA GeForce RTX 4090',
      device_count: 1,
    },
    phase: 'ready',
    phase_progress: 1,
  };
}

function probeReturning(payload: Record<string, unknown>): HttpWorkerHealthProbe {
  return new HttpWorkerHealthProbe({
    fetchTransport: (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as FetchTransport,
  });
}

describe('worker health contract', () => {
  it('accepts the health body the currently released worker actually serves', async () => {
    const probe = probeReturning(readyHealthPayload());

    const health = await probe.getHealth(deriveRunPodProxyUrl('contractpod1', 8000));

    expect(health).toEqual({ schemaVersion: 1, phase: 'ready', phaseProgress: 1 });
  });

  it('accepts additive diagnostic fields the worker reports for field triage', async () => {
    // The worker publishes unauthenticated I/O and loop-lag counters on
    // /v1/health. Validation is by named field, so additive blocks must never
    // turn a healthy Pod into a latched `error` phase the way a version
    // mismatch does.
    const withDiagnostics = {
      ...readyHealthPayload(),
      diagnostics: {
        volume_manifest_reads: 12,
        manifest_cache_hits: 340,
        artifact_digest_computations: 3,
        loop_lag_recent_ms: 1.25,
        loop_lag_peak_ms: 18.4,
      },
    };
    const probe = probeReturning(withDiagnostics);

    await expect(probe.getHealth(deriveRunPodProxyUrl('contractpod3', 8000))).resolves.toEqual({
      schemaVersion: 1,
      phase: 'ready',
      phaseProgress: 1,
    });
  });

  it('still rejects a worker whose version is not the released one', async () => {
    const stale = { ...readyHealthPayload(), version: '0.0.0-unreleased' };
    const probe = probeReturning(stale);

    await expect(probe.getHealth(deriveRunPodProxyUrl('contractpod2', 8000))).rejects.toMatchObject({
      code: 'api_response_invalid',
    });
  });
});
