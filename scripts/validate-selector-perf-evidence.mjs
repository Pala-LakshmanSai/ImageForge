#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { thresholdFor } from './selector-perf-thresholds.mjs';
import { createReadStream, lstatSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const FIXTURE_SHA256 = '102cfe7267c269a1344d3758ef1deea4cfbe5d469d2de9b996f5c06499eacf68';
const ROW_IDS_SHA256 = '83d20e051a50c2f0fbb16a459af0d67662acf81feaeddf9af0cab82b6cc3c71c';
const ACTIONS = ['cold_open', 'warm_open', 'refresh_loading', 'keyboard_move', 'keyboard_select'];
const VIEWPORTS = [[1280, 720], [1440, 900]];
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fail(message) {
  throw new Error(`Selector performance evidence invalid: ${message}`);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) fail('invalid arguments');
    values[key.slice(2)] = value;
    index += 1;
  }
  for (const key of ['evidence', 'artifact', 'commit', 'version', 'platform']) {
    if (!values[key]) fail(`--${key} is required`);
  }
  if (!COMMIT.test(values.commit) || !VERSION.test(values.version)) fail('build identity is malformed');
  if (!['macos-arm64', 'windows-x64'].includes(values.platform)) fail('platform is malformed');
  return {
    evidence: resolve(values.evidence),
    artifact: resolve(values.artifact),
    commit: values.commit,
    version: values.version,
    platform: values.platform,
  };
}

function keys(value, expected, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} is not an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} has unexpected fields`);
}

function jcs(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(',')}}`;
  fail('unsupported JSON value');
}

function hashFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function ensureNoSymlink(path) {
  const absolute = resolve(path);
  const root = resolve(process.cwd());
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) fail(`symlink path component: ${current}`);
  }
}

function p95(values) {
  return [...values].sort((left, right) => left - right)[28];
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  ensureNoSymlink(config.evidence);
  ensureNoSymlink(config.artifact);
  const evidence = JSON.parse(readFileSync(config.evidence, 'utf8'));
  keys(evidence, ['schemaVersion', 'platform', 'appVersion', 'commitSha', 'artifactSha256', 'fixtureId', 'fixtureSha256', 'thresholdUs', 'samplesPerActionViewport', 'samples', 'groups', 'evidenceSha256'], 'evidence');
  if (evidence.schemaVersion !== 1 || evidence.platform !== config.platform || evidence.appVersion !== config.version || evidence.commitSha !== config.commit || evidence.fixtureId !== 'gpu-selector-perf-10-v1' || evidence.fixtureSha256 !== FIXTURE_SHA256 || evidence.thresholdUs !== thresholdFor(config.platform) || evidence.samplesPerActionViewport !== 30 || !SHA256.test(evidence.artifactSha256) || evidence.artifactSha256 !== await hashFile(config.artifact)) fail('top-level build, fixture, threshold, or artifact binding mismatch');
  const canonicalPath = relative(process.cwd(), config.evidence).split(sep).join('/');
  const expectedPath = `release-evidence/gpu-selector-perf-v1/${config.commit}/${config.version}/${config.platform}/${evidence.artifactSha256}/gpu-selector-perf-10-v1__1280x720__1440x900.json`;
  if (canonicalPath !== expectedPath) fail(`canonical path is ${canonicalPath}, expected ${expectedPath}`);
  if (!Array.isArray(evidence.samples) || evidence.samples.length !== 300 || !Array.isArray(evidence.groups) || evidence.groups.length !== 10) fail('sample/group cardinality is invalid');
  const groups = new Map();
  const ids = new Set();
  for (const sample of evidence.samples) {
    keys(sample, ['schemaVersion', 'sampleId', 'platform', 'appVersion', 'commitSha', 'artifactSha256', 'viewportWidth', 'viewportHeight', 'action', 'ordinal', 'durationUs', 'mountedGpuRows', 'mountedRowIdsSha256'], 'sample');
    if (sample.schemaVersion !== 1 || !UUID_V4.test(sample.sampleId) || sample.platform !== config.platform || sample.appVersion !== config.version || sample.commitSha !== config.commit || sample.artifactSha256 !== evidence.artifactSha256 || sample.mountedGpuRows !== 10 || sample.mountedRowIdsSha256 !== ROW_IDS_SHA256 || !VIEWPORTS.some(([width, height]) => sample.viewportWidth === width && sample.viewportHeight === height) || !ACTIONS.includes(sample.action) || !Number.isInteger(sample.ordinal) || sample.ordinal < 1 || sample.ordinal > 30 || !Number.isSafeInteger(sample.durationUs) || sample.durationUs < 1 || sample.durationUs > 10_000_000 || !ids.add(sample.sampleId)) fail('sample binding, UUID, viewport, row, or duration is invalid');
    const key = `${sample.viewportWidth}x${sample.viewportHeight}:${sample.action}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  if (groups.size !== 10 || [...groups.values()].some((group) => group.length !== 30)) fail('every viewport/action group must contain 30 samples');
  for (const [key, group] of groups) {
    const ordered = [...group].sort((left, right) => left.ordinal - right.ordinal);
    if (ordered.some((sample, index) => sample.ordinal !== index + 1) || p95(ordered.map((sample) => sample.durationUs)) >= thresholdFor(config.platform)) fail(`ordinal or p95 failed for ${key}`);
  }
  const declaredGroups = new Set();
  for (const group of evidence.groups) {
    keys(group, ['platform', 'appVersion', 'commitSha', 'artifactSha256', 'viewportWidth', 'viewportHeight', 'action', 'p95Us'], 'group');
    const key = `${group.viewportWidth}x${group.viewportHeight}:${group.action}`;
    const samples = groups.get(key);
    if (!samples || !VIEWPORTS.some(([width, height]) => group.viewportWidth === width && group.viewportHeight === height) || !ACTIONS.includes(group.action) || group.platform !== config.platform || group.appVersion !== config.version || group.commitSha !== config.commit || group.artifactSha256 !== evidence.artifactSha256 || !Number.isSafeInteger(group.p95Us) || group.p95Us !== p95(samples.map((sample) => sample.durationUs)) || !declaredGroups.add(key)) fail(`declared group is invalid for ${key}`);
  }
  if (declaredGroups.size !== 10) fail('declared group set is incomplete');
  const withoutHash = { ...evidence };
  delete withoutHash.evidenceSha256;
  const expectedEvidenceHash = createHash('sha256').update(`${jcs(withoutHash)}\n`).digest('hex');
  if (evidence.evidenceSha256 !== expectedEvidenceHash || readFileSync(config.evidence, 'utf8') !== `${jcs(evidence)}\n`) fail('canonical JCS bytes or evidenceSha256 mismatch');
  console.log(JSON.stringify({ validated: true, evidence: config.evidence, artifactSha256: evidence.artifactSha256, evidenceSha256: evidence.evidenceSha256 }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
