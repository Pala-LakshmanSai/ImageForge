#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_BARRIER_TIMEOUT_MS = 25_000;

const FIRST_POD_ID = 'pod-native-smoke-a';
const SECOND_POD_ID = 'pod-native-smoke-b';
const INITIAL_BATCH_ID = '11111111-1111-4111-8111-111111111111';
const GENERATED_BATCH_ID = '77777777-7777-4777-8777-777777777777';
const FIRST_SERVER_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_SERVER_ID = '33333333-3333-4333-8333-333333333333';
// Derived, never duplicated. The desktop rejects any /v1/health body whose
// version is not the exact released string, so a hardcoded literal here silently
// stops matching the moment the worker is released and makes this fixture serve
// a body the app under test must refuse. Read the worker's own constant instead.
const WORKER_VERSION = (() => {
  const constants = fileURLToPath(
    new URL('../worker/src/imageforge_worker/constants.py', import.meta.url),
  );
  const match = /^WORKER_VERSION:\s*Final\s*=\s*"([^"]+)"/m.exec(
    readFileSync(constants, 'utf8'),
  );
  if (match === null) {
    throw new Error(`WORKER_VERSION not found in ${constants}`);
  }
  return match[1];
})();

const PRINCIPALS = Object.freeze({
  A: Object.freeze({ userId: 'lakshman', displayName: 'Lakshman' }),
  B: Object.freeze({ userId: 'sujal', displayName: 'Sujal' }),
});

const CHECKPOINTS = Object.freeze([
  'lifecycle_loading',
  'lifecycle_warming',
  'startup',
  'veto_done',
  'release_initial_batch',
  'idle_after_release',
  'direct_stop_a',
  'offline_a_to_b',
  'reset_second_pod',
  'ready_second_pod',
  'generation_started_b',
  'generation_veto_a',
  'release_generated_batch',
  'direct_stop_b',
  'offline_b_to_a',
  'final',
]);

const INPUT_FIELDS = Object.freeze({
  runpod_list: ['operation'],
  runpod_get: ['operation', 'pod_id'],
  runpod_delete: ['operation', 'pod_id'],
  worker_health: ['operation'],
  worker_status: ['operation'],
  studio_heartbeat: ['operation', 'session_id', 'availability'],
  studio_status: ['operation', 'session_id'],
  studio_create_stop: ['operation', 'request_id', 'session_id', 'pod_id', 'gpu_display_name'],
  studio_respond: ['operation', 'request_id', 'session_id', 'decision'],
  studio_finalize: ['operation', 'request_id', 'session_id', 'pod_id', 'finalization_id'],
  studio_cancel: ['operation', 'request_id', 'session_id', 'pod_id', 'finalization_id'],
  batch_create: ['operation', 'prompt_count', 'base_seed'],
  batch_get: ['operation', 'batch_id'],
  artifact_download: [
    'operation', 'batch_id', 'index', 'expected_sha256', 'expected_size_bytes',
    'expected_width', 'expected_height',
  ],
  checkpoint: ['operation', 'name'],
  audit: ['operation'],
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POD_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,56}[A-Za-z0-9])?$/;
const SAFE_KEY = /^[A-Za-z0-9_-]{32,128}$/;

class FixtureFault extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'FixtureFault';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fixtureFault(status, code, message, details = null) {
  return new FixtureFault(status, code, message, details);
}

function workerError(status, code, message, details = null) {
  return {
    status,
    body: { error: { code, message, details } },
    outcome: code,
  };
}

function success(status, body, outcome = 'ok') {
  return { status, body, outcome };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw fixtureFault(400, 'request_invalid', `${label} has an invalid field set.`);
  }
}

function boundedString(value, label, maximum) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || [...value].some((character) => /[\u0000-\u001f\u007f]/.test(character))
  ) {
    throw fixtureFault(400, 'request_invalid', `${label} is invalid.`);
  }
  return value;
}

function uuid(value, label) {
  const candidate = boundedString(value, label, 36);
  if (!UUID_V4.test(candidate)) throw fixtureFault(400, 'request_invalid', `${label} is invalid.`);
  return candidate;
}

function podId(value) {
  const candidate = boundedString(value, 'pod_id', 58);
  if (!POD_ID.test(candidate)) throw fixtureFault(400, 'request_invalid', 'pod_id is invalid.');
  return candidate;
}

function safeInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw fixtureFault(400, 'request_invalid', `${label} is invalid.`);
  }
  return value;
}

function validateInput(input) {
  if (!isRecord(input) || typeof input.operation !== 'string') {
    throw fixtureFault(400, 'request_invalid', 'input must be a tagged operation object.');
  }
  const fields = INPUT_FIELDS[input.operation];
  if (fields === undefined) throw fixtureFault(400, 'operation_not_allowed', 'The operation is not allowed.');
  exactKeys(input, fields, 'input');

  switch (input.operation) {
    case 'runpod_get':
    case 'runpod_delete':
      podId(input.pod_id);
      break;
    case 'studio_heartbeat':
      uuid(input.session_id, 'session_id');
      if (!['foreground', 'background'].includes(input.availability)) {
        throw fixtureFault(400, 'request_invalid', 'availability is invalid.');
      }
      break;
    case 'studio_status':
      uuid(input.session_id, 'session_id');
      break;
    case 'studio_create_stop':
      uuid(input.request_id, 'request_id');
      uuid(input.session_id, 'session_id');
      podId(input.pod_id);
      boundedString(input.gpu_display_name, 'gpu_display_name', 80);
      break;
    case 'studio_respond':
      uuid(input.request_id, 'request_id');
      uuid(input.session_id, 'session_id');
      if (!['approve', 'deny'].includes(input.decision)) {
        throw fixtureFault(400, 'request_invalid', 'decision is invalid.');
      }
      break;
    case 'studio_finalize':
      uuid(input.request_id, 'request_id');
      uuid(input.session_id, 'session_id');
      podId(input.pod_id);
      uuid(input.finalization_id, 'finalization_id');
      break;
    case 'studio_cancel':
      uuid(input.request_id, 'request_id');
      uuid(input.session_id, 'session_id');
      podId(input.pod_id);
      if (input.finalization_id !== null) uuid(input.finalization_id, 'finalization_id');
      break;
    case 'batch_create':
      safeInteger(input.prompt_count, 'prompt_count', 1, 450);
      safeInteger(input.base_seed, 'base_seed', 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'batch_get':
      uuid(input.batch_id, 'batch_id');
      break;
    case 'artifact_download':
      uuid(input.batch_id, 'batch_id');
      safeInteger(input.index, 'index', 1, 450);
      if (typeof input.expected_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.expected_sha256)) {
        throw fixtureFault(400, 'request_invalid', 'expected_sha256 is invalid.');
      }
      safeInteger(input.expected_size_bytes, 'expected_size_bytes', 1, 64 * 1024 * 1024);
      safeInteger(input.expected_width, 'expected_width', 64, 4096);
      safeInteger(input.expected_height, 'expected_height', 64, 4096);
      break;
    case 'checkpoint':
      if (!CHECKPOINTS.includes(input.name)) {
        throw fixtureFault(400, 'checkpoint_not_allowed', 'The checkpoint is not allowed.');
      }
      break;
    default:
      break;
  }
  return input;
}

function utc(milliseconds = Date.now()) {
  return new Date(milliseconds).toISOString();
}

function progress(total, completed, currentIndex, downloaded = 0) {
  return {
    total,
    completed,
    downloaded,
    failed: 0,
    cancelled: 0,
    processed: completed,
    current_index: currentIndex,
  };
}

function runPod(pod) {
  return {
    id: pod,
    name: `imageforge-${pod}`,
    desiredStatus: 'RUNNING',
    gpu: { id: 'NVIDIA GeForce RTX 4090', displayName: 'RTX 4090', count: 1 },
    templateId: 'q8sfgixfy2',
    interruptible: false,
    networkVolume: { id: 'ukh207b26r', dataCenterId: 'EU-RO-1' },
    volumeMountPath: '/workspace',
    machine: { secureCloud: true, dataCenterId: 'EU-RO-1' },
    ports: ['8000/http'],
    adjustedCostPerHr: 0.54,
    costPerHr: 0.54,
    createdAt: '2026-08-03T10:00:00.000Z',
  };
}

function workerHealth(stage) {
  const ready = stage === 'ready';
  const gpuReady = stage !== 'gpu_load';
  return {
    schema_version: 1,
    service: 'imageforge-worker',
    version: WORKER_VERSION,
    process: { status: 'ok', uptime_ms: 100 },
    model: {
      id: 'Comfy-Org/Mage-Flow',
      revision: 'd8c99241f6fa80fbd453014234af2bf337ea21e6',
      precision: 'int8-convrot',
      status: ready ? 'ready' : 'loading',
    },
    gpu: {
      state: gpuReady ? 'ready' : 'loading',
      available: gpuReady,
      approved: gpuReady,
      name: 'NVIDIA GeForce RTX 4090',
      device_count: gpuReady ? 1 : 0,
    },
    phase: stage,
    phase_progress: stage === 'gpu_load' ? 0.61 : stage === 'warmup' ? 0.82 : 1,
  };
}

function imageRecord(index, completed, currentIndex, baseSeed, downloaded) {
  const ready = index <= completed;
  const generating = index === currentIndex;
  const acknowledged = ready && downloaded;
  const sizeBytes = ready ? 4096 + index : null;
  return {
    index,
    prompt: `Native smoke image ${index}`,
    seed: baseSeed + index - 1,
    status: acknowledged ? 'downloaded' : ready ? 'ready' : generating ? 'generating' : 'pending',
    attempts: ready || generating ? 1 : 0,
    retry_rounds: 0,
    filename: ready ? `artifacts/${String(index).padStart(6, '0')}.jpg` : null,
    sha256: ready ? 'a'.repeat(64) : null,
    size_bytes: sizeBytes,
    generation_ms: ready ? 8400 : null,
    error: null,
    receipt: acknowledged ? {
      sha256: 'a'.repeat(64),
      size_bytes: sizeBytes,
      acknowledged_at: '2026-08-03T10:05:00.000Z',
    } : null,
  };
}

function batchManifest(batch) {
  return {
    schema_version: 1,
    batch_id: batch.batchId,
    owner: {
      user_id: PRINCIPALS[batch.ownerRole].userId,
      display_name: PRINCIPALS[batch.ownerRole].displayName,
    },
    state: 'running',
    created_at: '2026-08-03T10:00:00.000Z',
    updated_at: '2026-08-03T10:00:00.000Z',
    completed_at: null,
    interrupted_at: null,
    pause_requested: false,
    cancel_requested: false,
    settings: { width: 1280, height: 720 },
    references: [],
    images: Array.from(
      { length: batch.total },
      (_, offset) => imageRecord(
        offset + 1,
        batch.completed,
        batch.currentIndex,
        batch.baseSeed,
        batch.downloadedIndexes.has(offset + 1),
      ),
    ),
    progress: progress(
      batch.total,
      batch.completed,
      batch.currentIndex,
      batch.downloadedIndexes.size,
    ),
  };
}

function hashKey(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function keysMatch(actual, expectedDigest) {
  if (typeof actual !== 'string') return false;
  return timingSafeEqual(hashKey(actual), expectedDigest);
}

function withoutInternalResultFields(result) {
  return { status: result.status, body: result.body };
}

function responseJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function requestJson(request) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_REQUEST_BYTES) {
    throw fixtureFault(413, 'request_too_large', 'The request is too large.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw fixtureFault(413, 'request_too_large', 'The request is too large.');
    chunks.push(chunk);
  }
  if (size === 0) throw fixtureFault(400, 'request_invalid', 'The request body is missing.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fixtureFault(400, 'request_invalid', 'The request body is invalid JSON.');
  }
}

async function atomicWriteJson(target, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class NativeTwoClientSmokeAuthority {
  constructor({ key, auditFile, barrierTimeoutMs = DEFAULT_BARRIER_TIMEOUT_MS }) {
    if (!SAFE_KEY.test(key)) throw new Error('The fixture key must be 32-128 URL-safe characters.');
    if (typeof auditFile !== 'string' || auditFile.length === 0) throw new Error('An audit output file is required.');
    if (!Number.isSafeInteger(barrierTimeoutMs) || barrierTimeoutMs < 1_000 || barrierTimeoutMs > 29_000) {
      throw new Error('The barrier timeout must be between 1000 and 29000 milliseconds.');
    }
    this.keyDigest = hashKey(key);
    this.auditFile = auditFile;
    this.barrierTimeoutMs = barrierTimeoutMs;
    this.server = null;
    this.origin = null;
    this.sequence = 0;
    this.revision = 0;
    this.podId = FIRST_POD_ID;
    this.serverInstanceId = FIRST_SERVER_ID;
    this.healthStage = 'gpu_load';
    this.lifecycleObservers = new Map([
      ['gpu_load', new Set()],
      ['warmup', new Set()],
      ['ready', new Set()],
    ]);
    this.activeBatch = {
      batchId: INITIAL_BATCH_ID,
      ownerRole: 'A',
      total: 450,
      completed: 137,
      currentIndex: 138,
      baseSeed: 700,
      downloadedIndexes: new Set(),
    };
    this.sessions = new Map();
    this.sessionRoles = new Map();
    this.stopRequest = null;
    this.stopRequestIds = new Set();
    this.finalizationIds = new Set();
    this.stopOrdinal = 0;
    this.generatedBatchCreated = false;
    this.deletes = [];
    this.deleteEvents = [];
    this.unexpectedCreates = 0;
    this.unexpectedDeletes = 0;
    this.operationEvents = [];
    this.checkpointResults = [];
    this.checkpointIndex = 0;
    this.pendingCheckpoint = null;
    this.preflight = new Map();
    this.observedPods = new Map([[FIRST_POD_ID, new Set()]]);
    this.offlineObservers = new Map([[FIRST_POD_ID, new Set()], [SECOND_POD_ID, new Set()]]);
    this.idleObservers = new Set();
    this.stopStateObservers = new Map();
    this.evidence = {
      initialBusy: new Set(),
      initialArtifactsDownloaded: false,
      activeVetoB: false,
      generatedBusy: new Set(),
      deleteRefusedWhileGenerating: false,
      initialReleased: false,
      firstApproved: false,
      firstDeleted: false,
      secondPodReset: false,
      denial: false,
      timeout: false,
      generationWon: false,
      generatedReleased: false,
      reverseApproved: false,
      reverseDeleted: false,
    };
    this.security = { authenticationRejections: 0, validationRejections: 0 };
    this.finalAudit = null;
    this.auditWrite = null;
  }

  async start({ announce = true } = {}) {
    if (this.server !== null) throw new Error('The fixture server is already started.');
    this.server = createServer((request, response) => {
      void this.#serve(request, response);
    });
    this.server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(0, HOST, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string' || address.address !== HOST) {
      throw new Error('The fixture did not bind the required IPv4 loopback address.');
    }
    this.origin = `http://${HOST}:${address.port}/`;
    if (announce) {
      process.stdout.write(`${JSON.stringify({ event: 'ready', origin: this.origin, port: address.port })}\n`);
    }
    return { origin: this.origin, port: address.port };
  }

  async close() {
    if (this.pendingCheckpoint !== null) {
      for (const waiter of this.pendingCheckpoint.waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.resolve(workerError(503, 'fixture_stopped', 'The fixture stopped before the checkpoint completed.'));
      }
      this.pendingCheckpoint = null;
    }
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  async writeIncompleteAudit(reason = 'server_terminated_before_final') {
    if (this.auditWrite !== null) return this.auditWrite;
    const audit = this.#buildAudit(false, [reason]);
    this.auditWrite = atomicWriteJson(this.auditFile, audit);
    await this.auditWrite;
    return audit;
  }

  async #serve(request, response) {
    try {
      if (request.method !== 'POST' || request.url !== '/exchange') {
        throw fixtureFault(404, 'route_not_allowed', 'Only POST /exchange is available.');
      }
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
        throw fixtureFault(415, 'content_type_invalid', 'The request must contain JSON.');
      }
      const envelope = await requestJson(request);
      if (!isRecord(envelope)) throw fixtureFault(400, 'request_invalid', 'The exchange envelope is invalid.');
      exactKeys(envelope, ['role', 'key', 'input'], 'exchange envelope');
      if (!keysMatch(envelope.key, this.keyDigest)) {
        this.security.authenticationRejections += 1;
        throw fixtureFault(403, 'authentication_failed', 'The fixture authorization is invalid.');
      }
      if (!['A', 'B'].includes(envelope.role)) {
        throw fixtureFault(400, 'role_invalid', 'The fixture role is invalid.');
      }
      let input;
      try {
        input = validateInput(envelope.input);
      } catch (error) {
        this.security.validationRejections += 1;
        throw error;
      }
      const event = {
        sequence: ++this.sequence,
        role: envelope.role,
        operation: input.operation,
        status: null,
        outcome: null,
      };
      this.operationEvents.push(event);
      const result = await this.#exchange(envelope.role, input);
      event.status = result.status;
      event.outcome = result.outcome;
      responseJson(response, 200, withoutInternalResultFields(result));
    } catch (error) {
      const fault = error instanceof FixtureFault
        ? error
        : fixtureFault(500, 'fixture_failed', 'The fixture could not complete the operation.');
      responseJson(response, fault.status, {
        status: fault.status,
        body: { error: { code: fault.code, message: fault.message, details: fault.details } },
      });
    }
  }

  async #exchange(role, input) {
    switch (input.operation) {
      case 'runpod_list':
        return this.#runpodList(role);
      case 'runpod_get':
        return this.#runpodGet(role, input.pod_id);
      case 'runpod_delete':
        return this.#runpodDelete(role, input.pod_id);
      case 'worker_health':
        return this.#workerHealth(role);
      case 'worker_status':
        return this.#workerStatus(role);
      case 'studio_heartbeat':
        return this.#studioHeartbeat(role, input.session_id, input.availability);
      case 'studio_status':
        return this.#studioStatus(role, input.session_id);
      case 'studio_create_stop':
        return this.#studioCreateStop(role, input);
      case 'studio_respond':
        return this.#studioRespond(role, input);
      case 'studio_finalize':
        return this.#studioFinalize(role, input);
      case 'studio_cancel':
        return this.#studioCancel(role, input);
      case 'batch_create':
        return this.#batchCreate(role, input.prompt_count, input.base_seed);
      case 'batch_get':
        return this.#batchGet(role, input.batch_id);
      case 'artifact_download':
        return this.#artifactDownload(role, input);
      case 'checkpoint':
        return this.#checkpoint(role, input.name);
      case 'audit':
        return this.finalAudit === null
          ? workerError(409, 'audit_not_ready', 'The final checkpoint has not completed.')
          : success(200, this.#auditSummary(), 'passed');
      default:
        throw fixtureFault(400, 'operation_not_allowed', 'The operation is not allowed.');
    }
  }

  #runpodList(role) {
    if (this.podId === null) {
      const deleted = this.deletes.at(-1);
      if (deleted !== undefined) this.offlineObservers.get(deleted)?.add(role);
      return success(200, [], 'offline');
    }
    this.#markPodObserved(role, this.podId);
    return success(200, [runPod(this.podId)], this.podId);
  }

  #runpodGet(role, candidate) {
    if (this.podId !== candidate) {
      if (this.deletes.includes(candidate)) this.offlineObservers.get(candidate)?.add(role);
      return success(404, null, 'offline');
    }
    this.#markPodObserved(role, candidate);
    if (
      this.stopRequest !== null
      && this.stopRequest.state === 'approved'
      && this.stopRequest.requesterRole === role
      && this.stopRequest.podId === candidate
    ) {
      this.preflight.set(role, { podId: candidate, requestId: this.stopRequest.requestId });
    }
    return success(200, runPod(candidate), candidate);
  }

  #runpodDelete(role, candidate) {
    const request = this.stopRequest;
    const expectedRole = this.deletes.length === 0 ? 'A' : 'B';
    // Stop terminates directly now, so a delete arrives without a worker stop
    // request. The guards that still matter are the ones against destroying
    // work or the wrong Pod: the exact Pod, the expected role, a foreground
    // session, and no batch generating.
    // A delete refused because a batch is generating is the guard working, not
    // an unexpected mutation, so it is not counted as one.
    if (this.activeBatch !== null) {
      this.evidence.deleteRefusedWhileGenerating = true;
      return workerError(
        409,
        'delete_blocked_by_active_batch',
        'A batch is generating, so the Pod cannot be destroyed.',
      );
    }
    const directAuthorized = request === null
      && this.podId === candidate
      && role === expectedRole
      && this.sessions.get(role)?.availability === 'foreground'
      && this.activeBatch === null;
    const approvedAuthorized = request !== null
      && request.state === 'finalizing'
      && request.requesterRole === role
      && request.podId === candidate
      && request.finalizationId !== null;
    if (
      this.podId !== candidate
      || role !== expectedRole
      || !(directAuthorized || approvedAuthorized)
    ) {
      this.unexpectedDeletes += 1;
      return workerError(409, 'delete_not_authorized', 'The exact guarded Pod delete is not authorized.');
    }
    if (this.deletes.includes(candidate)) {
      this.unexpectedDeletes += 1;
      return workerError(409, 'duplicate_delete', 'The Pod delete was already consumed.');
    }
    this.deletes.push(candidate);
    this.deleteEvents.push({
      sequence: this.sequence,
      role,
      podId: candidate,
      requestId: request?.requestId ?? null,
      ordinal: this.deletes.length,
    });
    this.podId = null;
    this.preflight.clear();
    if (candidate === FIRST_POD_ID) {
      this.evidence.firstDeleted = true;
    } else if (candidate === SECOND_POD_ID) {
      this.evidence.reverseDeleted = true;
    }
    return success(204, null, candidate);
  }

  #workerHealth(role) {
    if (this.podId === null) return workerError(503, 'worker_offline', 'The worker is offline.');
    this.lifecycleObservers.get(this.healthStage)?.add(role);
    return success(200, workerHealth(this.healthStage), this.healthStage);
  }

  #workerStatus(role) {
    if (this.podId === null) return workerError(503, 'worker_offline', 'The worker is offline.');
    const active = this.activeBatch;
    if (active?.batchId === INITIAL_BATCH_ID) this.evidence.initialBusy.add(role);
    if (active?.batchId === GENERATED_BATCH_ID) this.evidence.generatedBusy.add(role);
    if (active === null && this.evidence.initialReleased && !this.generatedBatchCreated) {
      this.idleObservers.add(role);
    }
    const owner = active?.ownerRole === role;
    const stopFinalizing = active === null && this.stopRequest?.state === 'finalizing';
    return success(200, {
      schema_version: 1,
      ready: true,
      active_batch: this.#activeSummary(),
      permissions: {
        can_create: active === null && !stopFinalizing,
        can_manage_active: owner,
        is_owner: owner,
        create_block_reason: stopFinalizing ? 'gpu_stop_pending' : null,
      },
    }, active === null ? 'idle' : `active_${active.ownerRole}`);
  }

  #studioHeartbeat(role, sessionId, availability) {
    if (this.podId === null) return workerError(503, 'worker_offline', 'The worker is offline.');
    const existingRole = this.sessionRoles.get(sessionId);
    const existingSession = this.sessions.get(role);
    if ((existingRole !== undefined && existingRole !== role) || (existingSession && existingSession.sessionId !== sessionId)) {
      return workerError(409, 'studio_session_conflict', 'The smoke role is already bound to another session.');
    }
    this.sessions.set(role, { sessionId, availability });
    this.sessionRoles.set(sessionId, role);
    this.revision += 1;
    return success(200, this.#studioState(role), 'heartbeat');
  }

  #studioStatus(role, sessionId) {
    const error = this.#validateSession(role, sessionId);
    if (error !== null) return error;
    return success(200, this.#studioState(role), this.stopRequest?.state ?? 'idle');
  }

  #studioCreateStop(role, input) {
    const sessionError = this.#validateSession(role, input.session_id);
    if (sessionError !== null) return sessionError;
    const session = this.sessions.get(role);
    if (session.availability !== 'foreground') {
      return workerError(409, 'stop_response_not_allowed', 'A foreground session is required.');
    }
    if (this.activeBatch !== null) {
      if (role === 'B' && this.activeBatch.batchId === INITIAL_BATCH_ID) this.evidence.activeVetoB = true;
      return workerError(
        423,
        'stop_blocked_by_active_batch',
        'An active batch must finish before the GPU can stop.',
        {
          owner: PRINCIPALS[this.activeBatch.ownerRole].displayName,
          completed: this.activeBatch.completed,
          total: this.activeBatch.total,
        },
      );
    }
    if (this.podId === null || input.pod_id !== this.podId) {
      return workerError(409, 'stop_request_identity_mismatch', 'The Stop request does not match the current Pod.');
    }
    if (this.stopRequest !== null && ['pending', 'approved', 'finalizing'].includes(this.stopRequest.state)) {
      return workerError(409, 'stop_request_in_progress', 'Another Stop request is already active.');
    }
    if (this.stopRequestIds.has(input.request_id)) {
      return workerError(409, 'stop_request_identity_mismatch', 'The Stop request identifier was already used.');
    }
    const expectedRoles = ['A', 'B', 'A', 'A', 'B'];
    const expectedRole = expectedRoles[this.stopOrdinal];
    if (role !== expectedRole) {
      return workerError(409, 'scenario_order_invalid', 'The Stop requester is out of scenario order.');
    }
    const waitingRoles = [...this.sessions.entries()]
      .filter(([candidateRole, candidate]) => candidateRole !== role && candidate.availability === 'foreground')
      .map(([candidateRole]) => candidateRole)
      .sort();
    if (waitingRoles.length !== 1) {
      return workerError(409, 'scenario_presence_invalid', 'Both foreground principals must be present.');
    }
    const requestedAt = Date.now();
    this.stopRequest = {
      ordinal: this.stopOrdinal + 1,
      requestId: input.request_id,
      requesterRole: role,
      requesterSessionId: input.session_id,
      podId: input.pod_id,
      gpuDisplayName: input.gpu_display_name,
      state: 'pending',
      reason: null,
      requestedAt,
      responseDeadline: requestedAt + 30_000,
      finalizationExpiresAt: null,
      waitingRoles,
      approvedRoles: [],
      deniedRoles: [],
      finalizationId: null,
    };
    this.stopOrdinal += 1;
    this.stopRequestIds.add(input.request_id);
    this.revision += 1;
    return success(201, this.#studioState(role), 'pending');
  }

  #studioRespond(role, input) {
    const sessionError = this.#validateSession(role, input.session_id);
    if (sessionError !== null) return sessionError;
    const request = this.stopRequest;
    if (request === null || request.requestId !== input.request_id) {
      return workerError(404, 'stop_request_not_found', 'The Stop request was not found.');
    }
    if (request.state !== 'pending' || !request.waitingRoles.includes(role)) {
      return workerError(409, 'stop_response_not_allowed', 'This session cannot respond to the Stop request.');
    }
    request.waitingRoles = request.waitingRoles.filter((candidate) => candidate !== role);
    if (input.decision === 'deny') {
      request.deniedRoles.push(role);
      request.state = 'denied';
      request.reason = 'peer_denied';
      request.waitingRoles = [];
      if (request.ordinal === 2 && request.requesterRole === 'B' && role === 'A') this.evidence.denial = true;
    } else {
      request.approvedRoles.push(role);
      if (request.waitingRoles.length === 0) request.state = 'approved';
      if (request.ordinal === 1 && request.requesterRole === 'A' && role === 'B') this.evidence.firstApproved = true;
      if (request.ordinal === 5 && request.requesterRole === 'B' && role === 'A') this.evidence.reverseApproved = true;
    }
    this.revision += 1;
    return success(200, this.#studioState(role), request.state);
  }

  #studioFinalize(role, input) {
    const sessionError = this.#validateSession(role, input.session_id);
    if (sessionError !== null) return sessionError;
    const request = this.stopRequest;
    if (request === null || request.requestId !== input.request_id) {
      return workerError(404, 'stop_request_not_found', 'The Stop request was not found.');
    }
    const preflight = this.preflight.get(role);
    if (
      request.state !== 'approved'
      || request.requesterRole !== role
      || request.requesterSessionId !== input.session_id
      || request.podId !== input.pod_id
      || this.podId !== input.pod_id
      || preflight?.podId !== input.pod_id
      || preflight.requestId !== input.request_id
    ) {
      return workerError(409, 'stop_request_not_approved', 'The exact approved Stop request is not ready to finalize.');
    }
    if (this.finalizationIds.has(input.finalization_id)) {
      return workerError(409, 'finalization_mismatch', 'The finalization identifier was already used.');
    }
    request.state = 'finalizing';
    request.finalizationId = input.finalization_id;
    request.finalizationExpiresAt = Date.now() + 60_000;
    this.finalizationIds.add(input.finalization_id);
    this.preflight.delete(role);
    this.revision += 1;
    return success(200, this.#studioState(role), 'finalizing');
  }

  #studioCancel(role, input) {
    const sessionError = this.#validateSession(role, input.session_id);
    if (sessionError !== null) return sessionError;
    const request = this.stopRequest;
    if (request === null || request.requestId !== input.request_id) {
      return workerError(404, 'stop_request_not_found', 'The Stop request was not found.');
    }
    if (
      request.requesterRole !== role
      || request.requesterSessionId !== input.session_id
      || request.podId !== input.pod_id
      || (request.state === 'finalizing' && request.finalizationId !== input.finalization_id)
      || (request.state !== 'finalizing' && input.finalization_id !== null)
    ) {
      return workerError(409, 'finalization_mismatch', 'The Stop cancellation does not match the active request.');
    }
    request.state = 'cancelled';
    request.reason = 'requester_cancelled';
    request.waitingRoles = [];
    request.finalizationId = null;
    request.finalizationExpiresAt = null;
    this.revision += 1;
    return success(200, this.#studioState(role), 'cancelled');
  }

  #batchCreate(role, total, baseSeed) {
    if (this.stopRequest?.state === 'finalizing') {
      return workerError(423, 'gpu_stop_pending', 'GPU Stop is finalizing; generation is temporarily blocked.');
    }
    if (this.activeBatch !== null) {
      return workerError(423, 'batch_busy', 'Another batch owns the GPU.', {
        owner: PRINCIPALS[this.activeBatch.ownerRole].displayName,
        completed: this.activeBatch.completed,
        total: this.activeBatch.total,
      });
    }
    // The generation no longer races a pending stop request, because Stop no
    // longer creates one. B simply starts the batch, and A's Stop is refused
    // for as long as it generates.
    if (role !== 'B' || this.generatedBatchCreated) {
      this.unexpectedCreates += 1;
      return workerError(409, 'scenario_order_invalid', 'The generation admission is out of scenario order.');
    }
    this.activeBatch = {
      batchId: GENERATED_BATCH_ID,
      ownerRole: 'B',
      total,
      completed: 0,
      currentIndex: 1,
      baseSeed,
      downloadedIndexes: new Set(),
    };
    this.generatedBatchCreated = true;
    this.evidence.generationWon = true;
    this.revision += 1;
    return success(201, batchManifest(this.activeBatch), 'generation_started');
  }

  #batchGet(role, candidate) {
    if (this.activeBatch === null || this.activeBatch.batchId !== candidate || this.activeBatch.ownerRole !== role) {
      return workerError(404, 'batch_not_found', 'The batch was not found.');
    }
    return success(200, batchManifest(this.activeBatch), `active_${role}`);
  }

  #artifactDownload(role, input) {
    const active = this.activeBatch;
    if (
      active === null
      || active.ownerRole !== role
      || active.batchId !== input.batch_id
      || input.index > active.completed
      || input.expected_sha256 !== 'a'.repeat(64)
      || input.expected_size_bytes !== 4096 + input.index
      || input.expected_width !== 1280
      || input.expected_height !== 720
    ) {
      return workerError(409, 'artifact_download_invalid', 'The owner artifact download is invalid.');
    }
    active.downloadedIndexes.add(input.index);
    if (active.batchId === INITIAL_BATCH_ID && active.downloadedIndexes.size === active.completed) {
      this.evidence.initialArtifactsDownloaded = true;
    }
    return success(200, {
      schemaVersion: 1,
      batchId: active.batchId,
      index: input.index,
      filename: `batches/Two-client installed smoke/${String(input.index).padStart(6, '0')}.jpg`,
      sha256: input.expected_sha256,
      sizeBytes: input.expected_size_bytes,
      verifiedAtUnixMs: 1_775_210_700_000 + input.index,
    }, `artifact_${input.index}`);
  }

  #validateSession(role, sessionId) {
    const session = this.sessions.get(role);
    if (session === undefined || session.sessionId !== sessionId || this.sessionRoles.get(sessionId) !== role) {
      return workerError(404, 'studio_session_not_found', 'The studio session was not found.');
    }
    return null;
  }

  #activeSummary() {
    if (this.activeBatch === null) return null;
    return {
      batch_id: this.activeBatch.batchId,
      owner: {
        user_id: PRINCIPALS[this.activeBatch.ownerRole].userId,
        display_name: PRINCIPALS[this.activeBatch.ownerRole].displayName,
      },
      state: 'running',
      progress: progress(
        this.activeBatch.total,
        this.activeBatch.completed,
        this.activeBatch.currentIndex,
        this.activeBatch.downloadedIndexes.size,
      ),
      pause_requested: false,
      cancel_requested: false,
    };
  }

  #participant(role) {
    const session = this.sessions.get(role);
    if (session === undefined) throw new Error('A studio participant is missing.');
    return { session_id: session.sessionId, display_name: PRINCIPALS[role].displayName };
  }

  #session(role, now) {
    const session = this.sessions.get(role);
    if (session === undefined) throw new Error('A studio session is missing.');
    return {
      ...this.#participant(role),
      availability: session.availability,
      expires_at: utc(now + 15_000),
    };
  }

  #studioState(currentRole) {
    const now = Date.now();
    const request = this.stopRequest;
    const state = {
      schema_version: 1,
      server_instance_id: this.serverInstanceId,
      coordination_revision: this.revision,
      server_time: utc(now),
      presence_ttl_seconds: 15,
      response_ttl_seconds: 30,
      finalization_ttl_seconds: 60,
      current_session: this.#session(currentRole, now),
      sessions: [...this.sessions.keys()].sort().map((role) => this.#session(role, now)),
      active_batch: this.#activeSummary(),
      stop_request: request === null ? null : {
        request_id: request.requestId,
        pod_id: request.podId,
        gpu_display_name: request.gpuDisplayName,
        requester: this.#participant(request.requesterRole),
        state: request.state,
        reason: request.reason,
        requested_at: utc(request.requestedAt),
        response_deadline: utc(request.responseDeadline),
        finalization_expires_at: request.finalizationExpiresAt === null ? null : utc(request.finalizationExpiresAt),
        waiting_for: request.waitingRoles.map((role) => this.#participant(role)),
        approved_by: request.approvedRoles.map((role) => this.#participant(role)),
        denied_by: request.deniedRoles.map((role) => this.#participant(role)),
        finalization_id: request.state === 'finalizing' && request.requesterRole === currentRole
          ? request.finalizationId
          : null,
      },
      // Keep the fixture Studio projection aligned with the strict renderer
      // contract. Task-012 has no GPU Switch scenario, so both fields are
      // explicitly empty/false rather than omitted.
      gpu_switch_request: null,
      gpu_switch_can_respond: false,
    };
    this.#markStopStateObserved(currentRole, request?.state ?? 'idle');
    return state;
  }

  #markPodObserved(role, candidate) {
    if (!this.observedPods.has(candidate)) this.observedPods.set(candidate, new Set());
    this.observedPods.get(candidate).add(role);
  }

  #markStopStateObserved(role, state) {
    if (!this.stopStateObservers.has(state)) this.stopStateObservers.set(state, new Set());
    this.stopStateObservers.get(state).add(role);
  }

  #checkpoint(role, name) {
    const expected = CHECKPOINTS[this.checkpointIndex];
    if (name !== expected) {
      return Promise.resolve(workerError(
        409,
        'checkpoint_out_of_order',
        `Expected checkpoint ${expected ?? 'none'}.`,
      ));
    }
    if (this.pendingCheckpoint === null) {
      this.pendingCheckpoint = { name, waiters: new Map() };
    }
    if (this.pendingCheckpoint.name !== name) {
      return Promise.resolve(workerError(409, 'checkpoint_conflict', 'The peer is waiting at another checkpoint.'));
    }
    if (this.pendingCheckpoint.waiters.has(role)) {
      return Promise.resolve(workerError(409, 'checkpoint_duplicate', 'The role already reached this checkpoint.'));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingCheckpoint;
        if (pending?.name !== name) return;
        pending.waiters.delete(role);
        if (pending.waiters.size === 0) this.pendingCheckpoint = null;
        resolve(workerError(408, 'checkpoint_timeout', 'The peer did not reach the checkpoint in time.'));
      }, this.barrierTimeoutMs);
      this.pendingCheckpoint.waiters.set(role, { resolve, timer });
      if (this.pendingCheckpoint.waiters.size === 2) void this.#releaseCheckpoint(name);
    });
  }

  async #releaseCheckpoint(name) {
    const pending = this.pendingCheckpoint;
    if (pending === null || pending.name !== name) return;
    let result;
    try {
      const body = await this.#applyCheckpoint(name);
      result = success(200, body, name === 'final' && body.passed ? 'passed' : name);
      this.checkpointIndex += 1;
    } catch (error) {
      const fault = error instanceof FixtureFault
        ? error
        : fixtureFault(409, 'checkpoint_assertion_failed', 'The checkpoint state is invalid.');
      result = workerError(fault.status, fault.code, fault.message, fault.details);
    }
    this.pendingCheckpoint = null;
    for (const waiter of pending.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
  }

  async #applyCheckpoint(name) {
    const requireState = (condition, code) => {
      if (!condition) throw fixtureFault(409, code, 'The checkpoint state is invalid.');
    };
    switch (name) {
      case 'lifecycle_loading':
        requireState(
          ['A', 'B'].every((role) => this.lifecycleObservers.get('gpu_load')?.has(role)),
          'loading_convergence_missing',
        );
        this.healthStage = 'warmup';
        break;
      case 'lifecycle_warming':
        requireState(
          ['A', 'B'].every((role) => this.lifecycleObservers.get('warmup')?.has(role)),
          'warming_convergence_missing',
        );
        this.healthStage = 'ready';
        break;
      case 'startup':
        requireState(
          ['A', 'B'].every((role) => this.lifecycleObservers.get('ready')?.has(role)),
          'ready_convergence_missing',
        );
        break;
      case 'veto_done':
        // Stop no longer creates a worker stop request. The editors coordinate
        // outside the app, so the only surviving guard is a batch that is
        // actually generating, and the client enforces it from the status read
        // rather than by asking a peer. The evidence is therefore that B saw
        // the active batch and destroyed nothing; the client-side smoke asserts
        // that B also surfaced the stop-blocked outcome.
        requireState(
          this.evidence.initialBusy.has('B') && this.deletes.length === 0,
          'active_veto_missing',
        );
        this.evidence.activeVetoB = true;
        break;
      case 'release_initial_batch':
        requireState(this.activeBatch?.batchId === INITIAL_BATCH_ID, 'initial_batch_missing');
        this.activeBatch = null;
        this.evidence.initialReleased = true;
        this.revision += 1;
        break;
      case 'idle_after_release':
        requireState(['A', 'B'].every((role) => this.idleObservers.has(role)), 'idle_convergence_missing');
        break;
      case 'direct_stop_a':
        // Stop no longer asks a peer, so the only evidence is the exact guarded
        // delete of the Pod A terminated.
        requireState(
          this.deletes.length === 1 && this.deletes[0] === FIRST_POD_ID,
          'direct_stop_a_missing',
        );
        this.evidence.firstDeleted = true;
        break;
      case 'offline_a_to_b':
        requireState(this.offlineObservers.get(FIRST_POD_ID)?.has('B'), 'first_offline_convergence_missing');
        break;
      case 'reset_second_pod':
        requireState(this.podId === null && this.deletes.length === 1, 'first_pod_still_online');
        this.podId = SECOND_POD_ID;
        this.serverInstanceId = SECOND_SERVER_ID;
        this.revision = 0;
        this.sessions.clear();
        this.sessionRoles.clear();
        this.stopRequest = null;
        this.preflight.clear();
        this.observedPods.set(SECOND_POD_ID, new Set());
        this.evidence.secondPodReset = true;
        break;
      case 'ready_second_pod':
        requireState(
          this.evidence.secondPodReset
          && ['A', 'B'].every((role) => this.observedPods.get(SECOND_POD_ID)?.has(role))
          && ['A', 'B'].every((role) => this.sessions.has(role)),
          'second_ready_convergence_missing',
        );
        break;
      case 'generation_started_b':
        requireState(
          this.activeBatch?.batchId === GENERATED_BATCH_ID
          && this.activeBatch.ownerRole === 'B'
          && this.deletes.length === 1,
          'generation_start_missing',
        );
        this.evidence.generationWon = true;
        break;
      case 'generation_veto_a':
        // The surviving guard: a batch that is actually generating refuses the
        // other editor's Stop, and nothing is destroyed.
        requireState(
          this.evidence.generatedBusy.has('A') && this.deletes.length === 1,
          'generation_veto_missing',
        );
        break;
      case 'release_generated_batch':
        requireState(this.activeBatch?.batchId === GENERATED_BATCH_ID, 'generated_batch_missing');
        this.activeBatch = null;
        this.evidence.generatedReleased = true;
        this.revision += 1;
        break;
      case 'direct_stop_b':
        requireState(
          this.deletes.length === 2 && this.deletes[1] === SECOND_POD_ID,
          'direct_stop_b_missing',
        );
        this.evidence.reverseDeleted = true;
        break;
      case 'offline_b_to_a':
        requireState(this.offlineObservers.get(SECOND_POD_ID)?.has('A'), 'second_offline_convergence_missing');
        break;
      case 'final': {
        const assertions = this.#assertions();
        const failures = assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name);
        this.finalAudit = this.#buildAudit(failures.length === 0, failures, assertions);
        this.#assertAuditIsSanitized(this.finalAudit);
        this.auditWrite = atomicWriteJson(this.auditFile, this.finalAudit);
        await this.auditWrite;
        break;
      }
      default:
        throw fixtureFault(400, 'checkpoint_not_allowed', 'The checkpoint is not allowed.');
    }

    const result = name === 'final'
      ? this.#auditSummary()
      : {
          passed: true,
          name,
          podId: this.podId,
          activeBatchOwner: this.activeBatch?.ownerRole ?? null,
          stopState: this.stopRequest?.state ?? null,
          deleteCount: this.deletes.length,
        };
    this.checkpointResults.push({
      index: this.checkpointResults.length + 1,
      name,
      passed: result.passed,
      podId: this.podId,
      activeBatchOwner: this.activeBatch?.ownerRole ?? null,
      stopState: this.stopRequest?.state ?? null,
      deleteCount: this.deletes.length,
    });
    return result;
  }

  #assertions() {
    return [
      {
        name: 'both_roles_converged_loading_warming_ready',
        passed: ['gpu_load', 'warmup', 'ready'].every((stage) =>
          ['A', 'B'].every((role) => this.lifecycleObservers.get(stage)?.has(role))),
      },
      { name: 'both_roles_observed_initial_batch_450', passed: ['A', 'B'].every((role) => this.evidence.initialBusy.has(role)) },
      { name: 'initial_owner_streamed_137_artifacts', passed: this.evidence.initialArtifactsDownloaded },
      { name: 'active_batch_stop_vetoed_without_delete', passed: this.evidence.activeVetoB && this.evidence.initialReleased },
      { name: 'both_roles_observed_idle_release', passed: ['A', 'B'].every((role) => this.idleObservers.has(role)) },
      { name: 'a_directly_stopped_first_pod', passed: this.evidence.firstDeleted },
      { name: 'b_observed_first_remote_offline', passed: this.offlineObservers.get(FIRST_POD_ID)?.has('B') === true },
      { name: 'second_pod_new_worker_epoch', passed: this.evidence.secondPodReset && this.serverInstanceId === SECOND_SERVER_ID },
      { name: 'generating_batch_refused_peer_stop', passed: this.evidence.generationWon && this.evidence.generatedBusy.has('A') },
      { name: 'b_directly_stopped_second_pod', passed: this.evidence.reverseDeleted },
      { name: 'a_observed_second_remote_offline', passed: this.offlineObservers.get(SECOND_POD_ID)?.has('A') === true },
      { name: 'exact_delete_sequence', passed: JSON.stringify(this.deletes) === JSON.stringify([FIRST_POD_ID, SECOND_POD_ID]) },
      { name: 'no_unexpected_lifecycle_mutations', passed: this.unexpectedCreates === 0 && this.unexpectedDeletes === 0 },
      { name: 'no_stop_requests_were_created', passed: this.stopOrdinal === 0 },
    ];
  }

  #auditSummary() {
    return {
      passed: this.finalAudit?.passed === true,
      deletes: [...this.deletes],
      unexpectedCreates: this.unexpectedCreates,
      unexpectedDeletes: this.unexpectedDeletes,
      principals: [PRINCIPALS.A.displayName, PRINCIPALS.B.displayName],
    };
  }

  #buildAudit(passed, failures, assertions = this.#assertions()) {
    const operationCounts = {};
    for (const event of this.operationEvents) {
      const label = `${event.role}:${event.operation}`;
      operationCounts[label] = (operationCounts[label] ?? 0) + 1;
    }
    return {
      schemaVersion: 1,
      product: 'ImageForge',
      gate: 'Task 012 AC-13',
      fixture: 'native-two-client-loopback-authority',
      passed,
      failures,
      principals: [PRINCIPALS.A.displayName, PRINCIPALS.B.displayName],
      workerVersion: WORKER_VERSION,
      workerEpochs: [FIRST_SERVER_ID, SECOND_SERVER_ID],
      pods: [FIRST_POD_ID, SECOND_POD_ID],
      deletes: [...this.deletes],
      unexpectedCreates: this.unexpectedCreates,
      unexpectedDeletes: this.unexpectedDeletes,
      sessions: [...this.sessions.entries()].sort().map(([role, session]) => ({
        role,
        sessionId: session.sessionId,
        availability: session.availability,
      })),
      deleteEvents: this.deleteEvents.map((event) => ({ ...event })),
      checkpoints: this.checkpointResults.map((checkpoint) => ({ ...checkpoint })),
      assertions: assertions.map((assertion) => ({ ...assertion })),
      operations: this.operationEvents.map((event) => ({ ...event })),
      operationCounts,
      security: {
        loopbackOnly: true,
        randomAuthorizationRequired: true,
        requestBodiesRecorded: false,
        authenticationRejections: this.security.authenticationRejections,
        validationRejections: this.security.validationRejections,
      },
      finalState: {
        podId: this.podId,
        activeBatchOwner: this.activeBatch?.ownerRole ?? null,
        stopState: this.stopRequest?.state ?? null,
        deleteCount: this.deletes.length,
      },
    };
  }

  #assertAuditIsSanitized(audit) {
    const inspect = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) inspect(item);
        return;
      }
      if (!isRecord(value)) return;
      for (const [key, item] of Object.entries(value)) {
        if (/(?:secret|token|prompt|path)/i.test(key)) {
          throw new Error('The final audit contains a forbidden field.');
        }
        inspect(item);
      }
    };
    inspect(audit);
  }
}

function parseArguments(argv) {
  const options = { key: process.env.IMAGEFORGE_NATIVE_SMOKE_KEY ?? null, auditFile: null, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--self-test') {
      options.selfTest = true;
    } else if (argument === '--audit') {
      options.auditFile = argv[++index] ?? null;
    } else if (argument === '--help') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  IMAGEFORGE_NATIVE_SMOKE_KEY=<random-key> node scripts/native-two-client-smoke-server.mjs --audit <audit-json>',
    '  node scripts/native-two-client-smoke-server.mjs --self-test',
  ].join('\n');
}

async function post(origin, key, role, input, expectedHttpStatus = 200) {
  const response = await fetch(new URL('exchange', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, key, input }),
  });
  if (response.status !== expectedHttpStatus) {
    const detail = await response.text();
    throw new Error(
      `Expected HTTP ${expectedHttpStatus}, received ${response.status} for ${input.operation}: ${detail}`,
    );
  }
  return response.json();
}

function expect(condition, message) {
  if (!condition) throw new Error(`Self-test failed: ${message}`);
}

async function runSelfTest() {
  const directory = await mkdtemp(join(tmpdir(), 'imageforge-native-smoke-'));
  const auditFile = join(directory, 'audit.json');
  const key = randomBytes(32).toString('base64url');
  const authority = new NativeTwoClientSmokeAuthority({ key, auditFile, barrierTimeoutMs: 5_000 });
  const { origin } = await authority.start({ announce: false });
  const exchange = (role, input) => post(origin, key, role, input);
  const checkpoint = async (name) => {
    const [a, b] = await Promise.all([
      exchange('A', { operation: 'checkpoint', name }),
      exchange('B', { operation: 'checkpoint', name }),
    ]);
    expect(a.status === 200 && b.status === 200, `${name} did not release both roles`);
    return a.body;
  };
  const sessionA = '44444444-4444-4444-8444-444444444444';
  const sessionB = '55555555-5555-4555-8555-555555555555';
  const requestIds = [
    '60000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000002',
    '60000000-0000-4000-8000-000000000003',
    '60000000-0000-4000-8000-000000000004',
    '60000000-0000-4000-8000-000000000005',
  ];
  try {
    const rejectedKey = await post(origin, 'x'.repeat(32), 'A', { operation: 'audit' }, 403);
    expect(rejectedKey.body.error.code === 'authentication_failed', 'wrong key was not rejected');
    const rejectedOperation = await post(origin, key, 'A', { operation: 'generic_proxy' }, 400);
    expect(rejectedOperation.body.error.code === 'operation_not_allowed', 'unknown operation was not rejected');

    for (const role of ['A', 'B']) {
      expect((await exchange(role, { operation: 'runpod_list' })).body[0].id === FIRST_POD_ID, 'initial Pod mismatch');
      const health = await exchange(role, { operation: 'worker_health' });
      expect(health.body.version === WORKER_VERSION && health.body.phase === 'gpu_load', 'loading health mismatch');
    }
    await checkpoint('lifecycle_loading');
    for (const role of ['A', 'B']) {
      const health = await exchange(role, { operation: 'worker_health' });
      expect(health.body.phase === 'warmup', 'warming health mismatch');
    }
    await checkpoint('lifecycle_warming');
    for (const role of ['A', 'B']) {
      const health = await exchange(role, { operation: 'worker_health' });
      expect(health.body.phase === 'ready', 'ready health mismatch');
      const status = await exchange(role, { operation: 'worker_status' });
      expect(status.body.active_batch.batch_id === INITIAL_BATCH_ID, 'initial batch mismatch');
    }
    for (let index = 1; index <= 137; index += 1) {
      const artifact = await exchange('A', {
        operation: 'artifact_download',
        batch_id: INITIAL_BATCH_ID,
        index,
        expected_sha256: 'a'.repeat(64),
        expected_size_bytes: 4096 + index,
        expected_width: 1280,
        expected_height: 720,
      });
      expect(artifact.status === 200 && artifact.body.index === index, `artifact ${index} failed`);
    }
    const downloaded = await exchange('A', { operation: 'batch_get', batch_id: INITIAL_BATCH_ID });
    expect(downloaded.body.progress.downloaded === 137, 'owner artifact acknowledgements did not converge');
    await exchange('A', { operation: 'studio_heartbeat', session_id: sessionA, availability: 'foreground' });
    await exchange('B', { operation: 'studio_heartbeat', session_id: sessionB, availability: 'foreground' });
    await checkpoint('startup');

    const veto = await exchange('B', {
      operation: 'studio_create_stop',
      request_id: '60000000-0000-4000-8000-000000000000',
      session_id: sessionB,
      pod_id: FIRST_POD_ID,
      gpu_display_name: 'RTX 4090',
    });
    expect(veto.status === 423 && veto.body.error.code === 'stop_blocked_by_active_batch', 'active Stop was not vetoed');
    await checkpoint('veto_done');
    await checkpoint('release_initial_batch');
    for (const role of ['A', 'B']) {
      const status = await exchange(role, { operation: 'worker_status' });
      expect(status.body.active_batch === null && status.body.permissions.can_create, 'idle release was not visible');
    }
    await checkpoint('idle_after_release');

    expect(
      (await exchange('A', { operation: 'runpod_delete', pod_id: FIRST_POD_ID })).status === 204,
      'first Pod was not directly deleted',
    );
    await checkpoint('direct_stop_a');
    expect((await exchange('B', { operation: 'runpod_get', pod_id: FIRST_POD_ID })).status === 404, 'B did not observe first offline');
    await checkpoint('offline_a_to_b');
    await checkpoint('reset_second_pod');

    for (const role of ['A', 'B']) {
      expect((await exchange(role, { operation: 'runpod_list' })).body[0].id === SECOND_POD_ID, 'second Pod mismatch');
      await exchange(role, {
        operation: 'studio_heartbeat',
        session_id: role === 'A' ? sessionA : sessionB,
        availability: 'foreground',
      });
    }
    await checkpoint('ready_second_pod');

    const created = await exchange('B', { operation: 'batch_create', prompt_count: 1, base_seed: 700 });
    expect(created.status === 201 && created.body.batch_id === GENERATED_BATCH_ID, 'B generation did not start');
    expect((await exchange('B', { operation: 'batch_get', batch_id: GENERATED_BATCH_ID })).status === 200, 'B batch was not readable');
    await checkpoint('generation_started_b');

    // A reads the generating batch and its delete must be refused.
    await exchange('A', { operation: 'worker_status' });
    expect(
      (await exchange('A', { operation: 'runpod_delete', pod_id: SECOND_POD_ID })).status === 409,
      'a generating batch did not refuse the peer delete',
    );
    await checkpoint('generation_veto_a');
    await checkpoint('release_generated_batch');

    expect(
      (await exchange('B', { operation: 'runpod_delete', pod_id: SECOND_POD_ID })).status === 204,
      'second Pod was not directly deleted',
    );
    await checkpoint('direct_stop_b');
    expect((await exchange('A', { operation: 'runpod_list' })).body.length === 0, 'A did not observe second offline');
    await checkpoint('offline_b_to_a');
    const final = await checkpoint('final');
    if (!final.passed) {
      throw new Error(`final checkpoint failures: ${JSON.stringify(final.failures ?? final)}`);
    }
    expect(JSON.stringify(final.deletes) === JSON.stringify([FIRST_POD_ID, SECOND_POD_ID]), 'delete audit mismatch');
    const auditResult = await exchange('A', { operation: 'audit' });
    expect(auditResult.body.passed && auditResult.body.unexpectedDeletes === 0, 'audit operation did not pass');

    const text = await readFile(auditFile, 'utf8');
    const audit = JSON.parse(text);
    expect(audit.passed, 'written audit did not pass');
    expect(!text.includes(key), 'written audit reflected the authorization key');
    expect(!/(?:"[^"\n]*(?:secret|token|prompt|path)[^"\n]*"\s*:)/i.test(text), 'written audit contains a forbidden field');
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.selfTest) {
    await runSelfTest();
    process.stdout.write('native-two-client-smoke-server self-test passed\n');
    return;
  }
  if (options.key === null || options.auditFile === null) throw new Error(usage());
  const authority = new NativeTwoClientSmokeAuthority({ key: options.key, auditFile: options.auditFile });
  await authority.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      if (authority.finalAudit === null) await authority.writeIncompleteAudit();
      await authority.close();
      process.exitCode = authority.finalAudit?.passed === true ? 0 : 1;
    } catch {
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Native smoke fixture failed.'}\n`);
    process.exitCode = 1;
  });
}
