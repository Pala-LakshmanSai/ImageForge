import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const EVENT_ID = /^queue-complete:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const VIEWPORTS = [[1280, 720], [1440, 900], [1920, 1080]];

function fail(message) {
  throw new Error(`Queue release smoke evidence invalid: ${message}`);
}

function record(value, keys, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} is not an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has unexpected fields`);
  return value;
}

function unsignedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function p95(samples) {
  if (!Array.isArray(samples) || samples.length === 0 || samples.some((sample) => typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0)) fail('keyboard samples are invalid');
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

export function validateQueueReleaseSmokeEvidence(value) {
  const root = record(value, ['schemaVersion', 'smokeId', 'platform', 'architecture', 'appVersion', 'completedAt', 'viewport', 'queue', 'prompts', 'keyboard', 'minimized', 'alarm', 'runPod'], 'root');
  const viewport = record(root.viewport, ['width', 'height', 'horizontalOverflowPx'], 'viewport');
  const queue = record(root.queue, ['requestedRows', 'maxMountedRows', 'visibleRowLimit', 'realNativeBridge', 'runRevision', 'runnerLeaseReleased', 'batches'], 'queue');
  const prompts = record(root.prompts, ['requestedRows', 'maxMountedRows', 'visibleRowLimit'], 'prompts');
  const keyboard = record(root.keyboard, ['sampleCount', 'trustedSampleCount', 'key', 'operation', 'samplesMs', 'p95Ms'], 'keyboard');
  const minimized = record(root.minimized, ['observed', 'sequentialBatches'], 'minimized');
  const alarm = record(root.alarm, ['eventId', 'signalCalls', 'uniqueEvents', 'fixedPoint', 'disposition'], 'alarm');
  const runPod = record(root.runPod, ['createCalls', 'deleteCalls'], 'runPod');
  if (root.schemaVersion !== 1 || !UUID_V4.test(root.smokeId)) fail('root identity is invalid');
  if (!['macos', 'windows'].includes(root.platform) || !['aarch64', 'x86_64'].includes(root.architecture)) fail('target is invalid');
  if (typeof root.appVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(root.appVersion) || !exactTimestamp(root.completedAt)) fail('build identity is invalid');
  if (!unsignedInteger(viewport.width) || viewport.width < 900 || !unsignedInteger(viewport.height) || viewport.height < 650 || viewport.horizontalOverflowPx !== 0) fail('viewport gate failed');
  if (queue.requestedRows !== 450 || !unsignedInteger(queue.maxMountedRows) || queue.maxMountedRows < 1 || queue.maxMountedRows > 40 || queue.visibleRowLimit !== 40 || queue.realNativeBridge !== true || !UUID_V4.test(queue.runRevision) || queue.runnerLeaseReleased !== true) fail('queue DOM or runner-release gate failed');
  if (prompts.requestedRows !== 450 || !unsignedInteger(prompts.maxMountedRows) || prompts.maxMountedRows < 1 || prompts.maxMountedRows > 30 || prompts.visibleRowLimit !== 30) fail('prompt DOM gate failed');
  if (!Array.isArray(queue.batches) || queue.batches.length !== 3) fail('three batches are required');
  const queueIds = new Set(); const submissionIds = new Set(); const remoteIds = new Set();
  queue.batches.forEach((batchValue, index) => {
    const batch = record(batchValue, ['ordinal', 'queueItemId', 'clientSubmissionId', 'remoteBatchId', 'promptCount', 'preparedWithNativeBridge', 'receiptCount', 'receiptFixedPoint', 'terminalState', 'minimizedAtCompletion'], `batch ${index + 1}`);
    if (batch.ordinal !== index + 1 || !UUID_V4.test(batch.queueItemId) || !UUID_V4.test(batch.clientSubmissionId) || !UUID_V4.test(batch.remoteBatchId)) fail(`batch ${index + 1} identity is invalid`);
    if (new Set([batch.queueItemId, batch.clientSubmissionId, batch.remoteBatchId]).size !== 3) fail(`batch ${index + 1} identifiers overlap`);
    queueIds.add(batch.queueItemId); submissionIds.add(batch.clientSubmissionId); remoteIds.add(batch.remoteBatchId);
    if (!unsignedInteger(batch.promptCount) || batch.promptCount < 1 || batch.receiptCount !== batch.promptCount || batch.preparedWithNativeBridge !== true || batch.receiptFixedPoint !== true || batch.terminalState !== 'completed' || batch.minimizedAtCompletion !== true) fail(`batch ${index + 1} did not reach its installed fixed point`);
  });
  if (queueIds.size !== 3 || submissionIds.size !== 3 || remoteIds.size !== 3) fail('batch identifiers are not distinct');
  const calculatedP95 = p95(keyboard.samplesMs);
  if (keyboard.sampleCount !== 30 || keyboard.trustedSampleCount !== 30 || keyboard.samplesMs.length !== 30 || keyboard.key !== 'Enter' || keyboard.operation !== 'move' || keyboard.p95Ms !== calculatedP95 || keyboard.p95Ms >= 100) fail('trusted keyboard p95 gate failed');
  if (minimized.observed !== true || minimized.sequentialBatches !== 3) fail('minimized sequential run gate failed');
  if (!EVENT_ID.test(alarm.eventId) || alarm.eventId !== `queue-complete:${queue.runRevision}` || alarm.signalCalls !== 1 || alarm.uniqueEvents !== 1 || alarm.fixedPoint !== true || !['delivered', 'already_delivered', 'permission_denied', 'failed'].includes(alarm.disposition)) fail('completion alarm gate failed');
  if (runPod.createCalls !== 0 || runPod.deleteCalls !== 0) fail('queue smoke called RunPod create or delete');
  return value;
}

export function validateQueueReleaseSmokeAttestation(value, evidence) {
  const root = record(value, ['schemaVersion', 'smokeId', 'platform', 'architecture', 'appVersion', 'completedAt', 'phaseOnePid', 'resumePid', 'relaunchPid', 'distinctProcesses', 'artifacts', 'power', 'relaunch', 'alarmFallback', 'provider', 'decisionRecord'], 'attestation');
  if (root.schemaVersion !== 1 || root.smokeId !== evidence.smokeId || root.platform !== evidence.platform || root.architecture !== evidence.architecture || root.appVersion !== evidence.appVersion || root.completedAt !== evidence.completedAt) fail('attestation is not bound to the evidence');
  if (![root.phaseOnePid, root.resumePid, root.relaunchPid].every((pid) => unsignedInteger(pid) && pid > 0) || new Set([root.phaseOnePid, root.resumePid, root.relaunchPid]).size !== 3 || root.distinctProcesses !== true) fail('three distinct installed process epochs were not proven');
  const artifacts = record(root.artifacts, ['nativeVerified', 'batchFolderCount', 'jpegFileCount', 'receiptFileCount', 'batches'], 'artifacts');
  if (artifacts.nativeVerified !== true || artifacts.batchFolderCount !== 3 || !Array.isArray(artifacts.batches) || artifacts.batches.length !== 3) fail('native artifact ledger is incomplete');
  let fileCount = 0;
  artifacts.batches.forEach((batchValue, index) => {
    const batch = record(batchValue, ['ordinal', 'queueItemId', 'clientSubmissionId', 'remoteBatchId', 'batchFolder', 'promptCount', 'receiptCount', 'files'], `artifact batch ${index + 1}`);
    const expected = evidence.queue.batches[index];
    if (batch.ordinal !== index + 1 || batch.queueItemId !== expected.queueItemId || batch.clientSubmissionId !== expected.clientSubmissionId || batch.remoteBatchId !== expected.remoteBatchId || batch.promptCount !== expected.promptCount || batch.receiptCount !== expected.receiptCount || typeof batch.batchFolder !== 'string' || !batch.batchFolder || /[\\/\u0000-\u001f]/u.test(batch.batchFolder) || !Array.isArray(batch.files) || batch.files.length !== expected.receiptCount) fail(`artifact batch ${index + 1} is not bound to queue evidence`);
    batch.files.forEach((fileValue, offset) => {
      const file = record(fileValue, ['index', 'filename', 'receiptFilename', 'sha256', 'sizeBytes', 'width', 'height'], `artifact file ${index + 1}.${offset + 1}`);
      const imageIndex = offset + 1;
      if (file.index !== imageIndex || file.filename !== `batches/${batch.batchFolder}/${String(imageIndex).padStart(6, '0')}.jpg` || file.receiptFilename !== `.imageforge/receipts/${batch.remoteBatchId}/${String(imageIndex).padStart(6, '0')}.json` || !SHA256.test(file.sha256) || !unsignedInteger(file.sizeBytes) || file.sizeBytes < 1 || file.width !== 1280 || file.height !== 720) fail(`artifact file ${index + 1}.${imageIndex} is invalid`);
      fileCount += 1;
    });
  });
  if (artifacts.jpegFileCount !== fileCount || artifacts.receiptFileCount !== fileCount) fail('artifact and receipt totals are inconsistent');
  const power = record(root.power, ['requested', 'acquired', 'released', 'platform', 'displaySleepAllowed'], 'power');
  if (power.requested !== true || power.acquired !== true || power.released !== true || power.platform !== evidence.platform || power.displaySleepAllowed !== true) fail('keep-awake lifecycle was not acquired and released');
  const relaunch = record(root.relaunch, ['observed', 'observationMillis', 'stableStoreRevision', 'restartForcedPause', 'authorizationRequired', 'runnerState', 'alarmState', 'snoozeUsed', 'noAutomaticDispatch'], 'relaunch');
  if (relaunch.observed !== true || !unsignedInteger(relaunch.observationMillis) || relaunch.observationMillis < 1000 || relaunch.stableStoreRevision !== true || relaunch.restartForcedPause !== true || relaunch.authorizationRequired !== true || relaunch.runnerState !== 'completed' || relaunch.alarmState !== 'snoozed' || relaunch.snoozeUsed !== true || relaunch.noAutomaticDispatch !== true) fail('restart/alarm persistence gate failed');
  const fallback = record(root.alarmFallback, ['alarmRole', 'ringNowVisible', 'snoozeVisible', 'permissionDeniedFallbackVisible', 'trustedRingNowActivation', 'webAudioRingSucceeded', 'queueListSemantic', 'promptListSemantic', 'liveRegionPresent', 'focusedControlLabel', 'viewports'], 'alarm fallback');
  if (fallback.alarmRole !== 'alert' || fallback.focusedControlLabel !== 'Ring now' || ['ringNowVisible', 'snoozeVisible', 'permissionDeniedFallbackVisible', 'trustedRingNowActivation', 'webAudioRingSucceeded', 'queueListSemantic', 'promptListSemantic', 'liveRegionPresent'].some((key) => fallback[key] !== true) || !Array.isArray(fallback.viewports) || fallback.viewports.length !== 3) fail('alarm/audio/accessibility fallback gate failed');
  fallback.viewports.forEach((viewportValue, index) => {
    const viewport = record(viewportValue, ['width', 'height', 'horizontalOverflowPx', 'clippedAction', 'mountedQueueRows', 'mountedPromptRows'], `canonical viewport ${index + 1}`);
    if (viewport.width !== VIEWPORTS[index][0] || viewport.height !== VIEWPORTS[index][1] || viewport.horizontalOverflowPx !== 0 || viewport.clippedAction !== false || !unsignedInteger(viewport.mountedQueueRows) || viewport.mountedQueueRows < 1 || viewport.mountedQueueRows > 40 || !unsignedInteger(viewport.mountedPromptRows) || viewport.mountedPromptRows < 1 || viewport.mountedPromptRows > 30) fail(`canonical viewport ${index + 1} failed`);
  });
  const provider = record(root.provider, ['createCalls', 'deleteCalls', 'noProviderMutation', 'ledgerScope'], 'provider ledger');
  if (provider.createCalls !== 0 || provider.deleteCalls !== 0 || provider.noProviderMutation !== true || provider.ledgerScope !== 'registered_native_provider_boundaries') fail('provider mutation ledger failed');
  if (root.decisionRecord !== 'docs/TASK_013_QUEUE_RELEASE_DECISION_RECORD.md') fail('decision record is missing');
  return value;
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('artifact is not a JPEG');
  let offset = 2;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset]; offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (sof.has(marker)) return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    offset += length;
  }
  fail('artifact JPEG dimensions are unavailable');
}

function confinedFile(root, relative) {
  if (typeof relative !== 'string' || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..')) fail('artifact path is unsafe');
  const path = realpathSync(resolve(root, relative));
  if (path !== root && !path.startsWith(`${root}${sep}`)) fail('artifact escaped the isolated output root');
  if (!statSync(path).isFile()) fail('artifact is not a regular file');
  return path;
}

export function validateQueueReleaseArtifactTree(output, attestation) {
  const root = realpathSync(resolve(output));
  if (!statSync(root).isDirectory()) fail('artifact output root is invalid');
  for (const batch of attestation.artifacts.batches) {
    for (const file of batch.files) {
      const imageBytes = readFileSync(confinedFile(root, file.filename));
      if (imageBytes.length !== file.sizeBytes || createHash('sha256').update(imageBytes).digest('hex') !== file.sha256) fail('artifact bytes do not match attestation');
      const dimensions = jpegDimensions(imageBytes);
      if (dimensions.width !== file.width || dimensions.height !== file.height) fail('artifact JPEG dimensions do not match attestation');
      const receipt = record(JSON.parse(readFileSync(confinedFile(root, file.receiptFilename), 'utf8')), ['schemaVersion', 'batchId', 'index', 'filename', 'sha256', 'sizeBytes', 'verifiedAtUnixMs'], 'download receipt');
      if (receipt.schemaVersion !== 1 || receipt.batchId !== batch.remoteBatchId || receipt.index !== file.index || receipt.filename !== file.filename || receipt.sha256 !== file.sha256 || receipt.sizeBytes !== file.sizeBytes || !unsignedInteger(receipt.verifiedAtUnixMs) || receipt.verifiedAtUnixMs < 1) fail('download receipt does not bind the artifact');
    }
  }
}

function selfTestEvidence() {
  const runRevision = '33333333-3333-4333-8333-333333333333'; const samplesMs = Array.from({ length: 30 }, (_, index) => index + 1);
  return { schemaVersion: 1, smokeId: '44444444-4444-4444-8444-444444444444', platform: 'macos', architecture: 'aarch64', appVersion: '0.1.9', completedAt: '2026-08-03T12:00:00.000Z', viewport: { width: 1440, height: 900, horizontalOverflowPx: 0 }, queue: { requestedRows: 450, maxMountedRows: 12, visibleRowLimit: 40, realNativeBridge: true, runRevision, runnerLeaseReleased: true, batches: [1, 2, 3].map((ordinal) => ({ ordinal, queueItemId: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`, clientSubmissionId: `00000000-0000-4000-9000-${String(ordinal).padStart(12, '0')}`, remoteBatchId: `00000000-0000-4000-a000-${String(ordinal).padStart(12, '0')}`, promptCount: 1, preparedWithNativeBridge: true, receiptCount: 1, receiptFixedPoint: true, terminalState: 'completed', minimizedAtCompletion: true })) }, prompts: { requestedRows: 450, maxMountedRows: 15, visibleRowLimit: 30 }, keyboard: { sampleCount: 30, trustedSampleCount: 30, key: 'Enter', operation: 'move', samplesMs, p95Ms: 29 }, minimized: { observed: true, sequentialBatches: 3 }, alarm: { eventId: `queue-complete:${runRevision}`, signalCalls: 1, uniqueEvents: 1, fixedPoint: true, disposition: 'delivered' }, runPod: { createCalls: 0, deleteCalls: 0 } };
}

function selfTestAttestation(evidence) {
  const batches = evidence.queue.batches.map((batch) => ({ ordinal: batch.ordinal, queueItemId: batch.queueItemId, clientSubmissionId: batch.clientSubmissionId, remoteBatchId: batch.remoteBatchId, batchFolder: `batch-${batch.ordinal}`, promptCount: batch.promptCount, receiptCount: batch.receiptCount, files: [{ index: 1, filename: `batches/batch-${batch.ordinal}/000001.jpg`, receiptFilename: `.imageforge/receipts/${batch.remoteBatchId}/000001.json`, sha256: String(batch.ordinal).repeat(64), sizeBytes: 100, width: 1280, height: 720 }] }));
  return { schemaVersion: 1, smokeId: evidence.smokeId, platform: evidence.platform, architecture: evidence.architecture, appVersion: evidence.appVersion, completedAt: evidence.completedAt, phaseOnePid: 101, resumePid: 202, relaunchPid: 303, distinctProcesses: true, artifacts: { nativeVerified: true, batchFolderCount: 3, jpegFileCount: 3, receiptFileCount: 3, batches }, power: { requested: true, acquired: true, released: true, platform: evidence.platform, displaySleepAllowed: true }, relaunch: { observed: true, observationMillis: 1000, stableStoreRevision: true, restartForcedPause: true, authorizationRequired: true, runnerState: 'completed', alarmState: 'snoozed', snoozeUsed: true, noAutomaticDispatch: true }, alarmFallback: { alarmRole: 'alert', ringNowVisible: true, snoozeVisible: true, permissionDeniedFallbackVisible: true, trustedRingNowActivation: true, webAudioRingSucceeded: true, queueListSemantic: true, promptListSemantic: true, liveRegionPresent: true, focusedControlLabel: 'Ring now', viewports: VIEWPORTS.map(([width, height]) => ({ width, height, horizontalOverflowPx: 0, clippedAction: false, mountedQueueRows: 12, mountedPromptRows: 15 })) }, provider: { createCalls: 0, deleteCalls: 0, noProviderMutation: true, ledgerScope: 'registered_native_provider_boundaries' }, decisionRecord: 'docs/TASK_013_QUEUE_RELEASE_DECISION_RECORD.md' };
}

function runSelfTest() {
  const evidence = validateQueueReleaseSmokeEvidence(selfTestEvidence());
  const attestation = validateQueueReleaseSmokeAttestation(selfTestAttestation(evidence), evidence);
  for (const mutation of [
    { ...attestation, resumePid: attestation.phaseOnePid },
    { ...attestation, relaunch: { ...attestation.relaunch, restartForcedPause: false } },
    { ...attestation, provider: { ...attestation.provider, createCalls: 1 } },
    { ...attestation, alarmFallback: { ...attestation.alarmFallback, viewports: attestation.alarmFallback.viewports.slice(0, 2) } },
  ]) {
    let rejected = false; try { validateQueueReleaseSmokeAttestation(mutation, evidence); } catch { rejected = true; }
    if (!rejected) fail('self-test accepted tampered attestation');
  }
  const root = mkdtempSync(join(tmpdir(), 'imageforge-queue-release-validator-'));
  try {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
    for (const batch of attestation.artifacts.batches) {
      const file = batch.files[0];
      const digest = createHash('sha256').update(jpeg).digest('hex');
      file.sha256 = digest;
      file.sizeBytes = jpeg.length;
      mkdirSync(resolve(root, `batches/${batch.batchFolder}`), { recursive: true });
      mkdirSync(resolve(root, `.imageforge/receipts/${batch.remoteBatchId}`), { recursive: true });
      writeFileSync(resolve(root, file.filename), jpeg);
      writeFileSync(resolve(root, file.receiptFilename), JSON.stringify({ schemaVersion: 1, batchId: batch.remoteBatchId, index: file.index, filename: file.filename, sha256: digest, sizeBytes: jpeg.length, verifiedAtUnixMs: 1 }));
    }
    validateQueueReleaseArtifactTree(root, attestation);
    writeFileSync(resolve(root, attestation.artifacts.batches[0].files[0].filename), Buffer.concat([jpeg, Buffer.from([0])]));
    let rejected = false; try { validateQueueReleaseArtifactTree(root, attestation); } catch { rejected = true; }
    if (!rejected) fail('self-test accepted tampered artifact bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write('Queue release smoke validator self-test passed.\n');
}

function readBoundedJson(path) {
  const encoded = readFileSync(resolve(path));
  if (encoded.length < 2 || encoded.length > 1024 * 1024) fail('file size is invalid');
  return { encoded, value: JSON.parse(encoded.toString('utf8')) };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv[2] === '--self-test' && process.argv.length === 3) {
    runSelfTest();
  } else if (process.argv.length === 5) {
    const evidenceFile = readBoundedJson(process.argv[2]); const attestationFile = readBoundedJson(process.argv[3]);
    const evidence = validateQueueReleaseSmokeEvidence(evidenceFile.value); const attestation = validateQueueReleaseSmokeAttestation(attestationFile.value, evidence);
    validateQueueReleaseArtifactTree(process.argv[4], attestation);
    process.stdout.write(`${JSON.stringify({ passed: true, platform: evidence.platform, architecture: evidence.architecture, p95Ms: evidence.keyboard.p95Ms, evidenceSha256: createHash('sha256').update(evidenceFile.encoded).digest('hex'), attestationSha256: createHash('sha256').update(attestationFile.encoded).digest('hex'), artifactFiles: attestation.artifacts.jpegFileCount })}\n`);
  } else {
    process.stderr.write('Usage: node scripts/validate-queue-release-smoke.mjs <evidence.json> <attestation.json> <output-directory> | --self-test\n');
    process.exitCode = 2;
  }
}
