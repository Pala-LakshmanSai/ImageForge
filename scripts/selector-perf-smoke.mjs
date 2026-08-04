#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const FIXTURE_SHA256 = '102cfe7267c269a1344d3758ef1deea4cfbe5d469d2de9b996f5c06499eacf68';
const ROW_IDS_SHA256 = '83d20e051a50c2f0fbb16a459af0d67662acf81feaeddf9af0cab82b6cc3c71c';
const ACTIONS = ['cold_open', 'warm_open', 'refresh_loading', 'keyboard_move', 'keyboard_select'];
const VIEWPORTS = [[1280, 720], [1440, 900]];
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

function fail(message) {
  throw new Error(`Selector performance smoke failed: ${message}`);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) fail(`unexpected argument ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  const required = ['binary', 'artifact-sha256', 'commit', 'version', 'platform', 'output-root'];
  required.forEach((key) => {
    if (!values[key]) fail(`--${key} is required`);
  });
  if (!existsSync(values.binary) || !statSync(values.binary).isFile()) fail(`binary does not exist: ${values.binary}`);
  if (!SHA256.test(values['artifact-sha256'])) fail('artifact SHA-256 is invalid');
  if (!COMMIT.test(values.commit)) fail('commit SHA is invalid');
  if (!VERSION.test(values.version)) fail('app version is invalid');
  if (!['macos-arm64', 'windows-x64'].includes(values.platform)) fail('platform is invalid');
  return {
    binary: resolve(values.binary),
    artifactSha256: values['artifact-sha256'],
    commitSha: values.commit,
    appVersion: values.version,
    platform: values.platform,
    outputRoot: resolve(values['output-root']),
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

function macProcessScript(pid, body) {
  return `tell application "System Events"
  set targetProcess to first process whose unix id is ${pid}
  tell targetProcess
    ${body}
  end tell
end tell`;
}

function macFocus(pid) {
  run('osascript', ['-e', macProcessScript(pid, 'set frontmost to true')]);
}

const MAC_INPUT_HELPER_SOURCE = String.raw`
#include <CoreGraphics/CoreGraphics.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int parse_number(const char *value, long minimum, long maximum, long *parsed) {
  char *end = NULL;
  errno = 0;
  long candidate = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != 0 || candidate < minimum || candidate > maximum) return 0;
  *parsed = candidate;
  return 1;
}

static int post_click(double x, double y) {
  CGPoint point = CGPointMake(x, y);
  CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
  CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
  if (down == NULL || up == NULL) {
    if (down != NULL) CFRelease(down);
    if (up != NULL) CFRelease(up);
    return 1;
  }
  CGEventPost(kCGHIDEventTap, down);
  usleep(1000);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(down);
  CFRelease(up);
  return 0;
}

static int post_key(long key_code) {
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)key_code, true);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)key_code, false);
  if (down == NULL || up == NULL) {
    if (down != NULL) CFRelease(down);
    if (up != NULL) CFRelease(up);
    return 1;
  }
  CGEventPost(kCGHIDEventTap, down);
  usleep(1000);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(down);
  CFRelease(up);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 4 && strcmp(argv[1], "click") == 0) {
    char *x_end = NULL;
    char *y_end = NULL;
    errno = 0;
    double x = strtod(argv[2], &x_end);
    double y = strtod(argv[3], &y_end);
    if (errno != 0 || x_end == argv[2] || *x_end != 0 || y_end == argv[3] || *y_end != 0) {
      fprintf(stderr, "invalid click coordinates\n");
      return 2;
    }
    return post_click(x, y);
  }
  if (argc == 3 && strcmp(argv[1], "key") == 0) {
    long key_code = 0;
    if (!parse_number(argv[2], 0, 255, &key_code)) {
      fprintf(stderr, "invalid key code\n");
      return 2;
    }
    return post_key(key_code);
  }
  fprintf(stderr, "usage: %s click <x> <y> | key <key-code>\n", argv[0]);
  return 2;
}
`;

function createMacInputHelper() {
  const root = mkdtempSync(join(tmpdir(), 'imageforge-selector-input-'));
  const sourcePath = join(root, 'input.c');
  const binaryPath = join(root, 'input');
  writeFileSync(sourcePath, MAC_INPUT_HELPER_SOURCE, 'utf8');
  try {
    run('clang', ['-O2', sourcePath, '-framework', 'CoreGraphics', '-o', binaryPath]);
    if (!existsSync(binaryPath)) fail(`macOS input helper was not created at ${binaryPath}`);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    path: binaryPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function macMetrics(pid) {
  const output = run('osascript', ['-e', macProcessScript(pid, 'set p to position of window 1\n    set s to size of window 1\n    return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)')]);
  const values = output.split(',').map((value) => Number(value));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) fail(`invalid macOS window metrics: ${output}`);
  return { left: values[0], top: values[1], width: values[2], height: values[3] };
}

function macClick(pid, location, inputHelperPath) {
  macFocus(pid);
  run(inputHelperPath, ['click', String(Math.round(location.x)), String(Math.round(location.y))]);
}

function macKey(pid, keyCode, inputHelperPath) {
  macFocus(pid);
  run(inputHelperPath, ['key', String(keyCode)]);
}

const WINDOWS_HELPER = `
using System;
using System.Runtime.InteropServices;
public static class ImageForgePerfInput {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public const uint MOUSE_DOWN = 0x0002, MOUSE_UP = 0x0004, KEY_UP = 0x0002;
}`;

function windowsCommand(pid, action) {
  const script = `Add-Type @'
${WINDOWS_HELPER}
'@
$process = Get-Process -Id ${pid} -ErrorAction Stop
$handle = $process.MainWindowHandle
if ($handle -eq 0) { throw 'main window is unavailable' }
[ImageForgePerfInput]::SetForegroundWindow($handle) | Out-Null
${action}`;
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

function windowsMetrics(pid) {
  const output = windowsCommand(pid, '$rect = New-Object ImageForgePerfInput+RECT\n[ImageForgePerfInput]::GetWindowRect($handle, [ref]$rect) | Out-Null\nWrite-Output ("{0},{1},{2},{3}" -f $rect.Left,$rect.Top,($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))');
  const values = output.split(',').map((value) => Number(value));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) fail(`invalid Windows window metrics: ${output}`);
  return { left: values[0], top: values[1], width: values[2], height: values[3] };
}

function windowsClick(pid, location) {
  windowsCommand(pid, `[ImageForgePerfInput]::SetCursorPos(${Math.round(location.x)}, ${Math.round(location.y)}) | Out-Null\n[ImageForgePerfInput]::mouse_event([ImageForgePerfInput]::MOUSE_DOWN,0,0,0,[UIntPtr]::Zero)\n[ImageForgePerfInput]::mouse_event([ImageForgePerfInput]::MOUSE_UP,0,0,0,[UIntPtr]::Zero)`);
}

function windowsKey(pid, virtualKey) {
  windowsCommand(pid, `[ImageForgePerfInput]::keybd_event(${virtualKey},0,0,[UIntPtr]::Zero)\n[ImageForgePerfInput]::keybd_event(${virtualKey},0,[ImageForgePerfInput]::KEY_UP,[UIntPtr]::Zero)`);
}

function windowMetrics(platform, pid) {
  return platform === 'macos-arm64' ? macMetrics(pid) : windowsMetrics(pid);
}

function focusWindow(platform, pid) {
  if (platform === 'macos-arm64') macFocus(pid);
  else windowsCommand(pid, '');
}

function clickAt(platform, pid, kind, macInputHelperPath) {
  // Resize is asynchronous in the renderer. Re-read the native frame for
  // every click so titlebar/content movement cannot send a sample to stale
  // coordinates.
  const metrics = windowMetrics(platform, pid);
  const locations = {
    center: { x: metrics.left + metrics.width / 2, y: metrics.top + metrics.height / 2 },
    close: { x: metrics.left + metrics.width - 80, y: metrics.top + 55 },
    refresh: { x: metrics.left + 80, y: metrics.top + 55 },
  };
  const location = locations[kind];
  if (!location) fail(`unknown click target ${kind}`);
  if (platform === 'macos-arm64') macClick(pid, location, macInputHelperPath);
  else windowsClick(pid, location);
}

function sendKey(platform, pid, key, macInputHelperPath) {
  if (platform === 'macos-arm64') {
    const codes = { up: 126, down: 125, space: 49 };
    macKey(pid, codes[key], macInputHelperPath);
  } else {
    const codes = { up: 0x26, down: 0x28, space: 0x20 };
    windowsKey(pid, codes[key]);
  }
}

function waitForFile(path, timeoutMs, child, description) {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (existsSync(path)) {
        resolvePromise();
        return;
      }
      if (child.exitCode !== null) {
        reject(new Error(`${description} process exited ${child.exitCode} before its result was written.`));
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`${description} timed out waiting for ${path}.`));
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}

function sampleCount(path) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).length;
}

async function waitForSamples(path, count, child, description) {
  const deadline = Date.now() + 15_000;
  while (sampleCount(path) < count) {
    if (child.exitCode !== null) fail(`${description} exited ${child.exitCode} before sample ${count}`);
    if (Date.now() >= deadline) fail(`${description} timed out after ${sampleCount(path)} samples; expected ${count}`);
    await sleep(100);
  }
}

function launch(config, action, width, height, samplesPath, resultPath, logPath) {
  const qaSessionId = randomUUID();
  const session = JSON.stringify({
    schemaVersion: 1,
    qaSessionId,
    platform: config.platform,
    appVersion: config.appVersion,
    commitSha: config.commitSha,
    artifactSha256: config.artifactSha256,
    fixtureSha256: FIXTURE_SHA256,
    windowLabel: 'main',
  });
  const environment = {
    ...process.env,
    IMAGEFORGE_NATIVE_SMOKE: 'selector-perf',
    IMAGEFORGE_NATIVE_SMOKE_RESULT: resultPath,
    IMAGEFORGE_GPU_SELECTOR_PERF_QA: '1',
    IMAGEFORGE_GPU_SELECTOR_PERF_QA_SESSION: session,
    IMAGEFORGE_GPU_SELECTOR_PERF_QA_SAMPLES: samplesPath,
    IMAGEFORGE_GPU_SELECTOR_PERF_ACTION: action,
    IMAGEFORGE_GPU_SELECTOR_PERF_VIEWPORT_WIDTH: String(width),
    IMAGEFORGE_GPU_SELECTOR_PERF_VIEWPORT_HEIGHT: String(height),
  };
  if (config.platform === 'windows-x64') {
    const profile = join(resolve(config.outputRoot), '.selector-perf-profile', `${action}-${width}x${height}-${qaSessionId}`);
    mkdirSync(profile, { recursive: true });
    environment.IMAGEFORGE_NATIVE_SMOKE_PROFILE = profile;
  }
  const child = spawn(config.binary, [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (chunk) => log.push(chunk.toString()));
  child.stderr.on('data', (chunk) => log.push(chunk.toString()));
  child.on('close', () => {
    writeFileSync(logPath, log.join(''), 'utf8');
  });
  return child;
}

async function stopChild(config, child) {
  if (child.exitCode !== null) return;
  if (config.platform === 'windows-x64') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function runGroup(config, action, width, height, groupRoot, macInputHelperPath) {
  const allSamples = [];
  const launches = action === 'cold_open' ? 30 : 1;
  for (let launchIndex = 0; launchIndex < launches; launchIndex += 1) {
    const runRoot = join(groupRoot, `${String(launchIndex + 1).padStart(2, '0')}`);
    mkdirSync(runRoot, { recursive: true });
    const samplesPath = join(runRoot, 'samples.ndjson');
    const resultPath = join(runRoot, 'result.txt');
    const logPath = join(runRoot, 'app.log');
    const child = launch(config, action, width, height, samplesPath, resultPath, logPath);
    try {
      const windowDeadline = Date.now() + 30_000;
      let metrics;
      while (!metrics && Date.now() < windowDeadline) {
        try {
          metrics = windowMetrics(config.platform, child.pid);
        } catch {
          await sleep(250);
        }
      }
      if (!metrics) fail(`${action} ${width}x${height} did not create a measurable window`);
      focusWindow(config.platform, child.pid);
      await sleep(750);

      if (action === 'cold_open') {
        clickAt(config.platform, child.pid, 'center', macInputHelperPath);
        await waitForFile(resultPath, 20_000, child, `${action} launch ${launchIndex + 1}`);
      } else if (action === 'warm_open') {
        // Three close/open cycles are intentionally unrecorded warm-ups. The
        // harness arms only after the final close, so those clicks cannot mint
        // selector samples.
        for (let warmup = 0; warmup < 3; warmup += 1) {
          clickAt(config.platform, child.pid, 'close', macInputHelperPath);
          await sleep(250);
          clickAt(config.platform, child.pid, 'center', macInputHelperPath);
          await sleep(400);
        }
        clickAt(config.platform, child.pid, 'close', macInputHelperPath);
        await sleep(500);
        for (let ordinal = 1; ordinal <= 30; ordinal += 1) {
          clickAt(config.platform, child.pid, 'center', macInputHelperPath);
          await waitForSamples(samplesPath, ordinal, child, `${action} ${width}x${height}`);
          await sleep(250);
        }
        await waitForFile(resultPath, 10_000, child, `${action} ${width}x${height}`);
      } else if (action === 'refresh_loading') {
        for (let ordinal = 1; ordinal <= 30; ordinal += 1) {
          clickAt(config.platform, child.pid, 'refresh', macInputHelperPath);
          await waitForSamples(samplesPath, ordinal, child, `${action} ${width}x${height}`);
        }
        await waitForFile(resultPath, 10_000, child, `${action} ${width}x${height}`);
      } else {
        for (let ordinal = 1; ordinal <= 30; ordinal += 1) {
          const key = action === 'keyboard_move'
            ? (ordinal % 2 === 1 ? 'down' : 'up')
            : 'space';
          sendKey(config.platform, child.pid, key, macInputHelperPath);
          await waitForSamples(samplesPath, ordinal, child, `${action} ${width}x${height}`);
        }
        await waitForFile(resultPath, 10_000, child, `${action} ${width}x${height}`);
      }
      if (readFileSync(resultPath, 'utf8').split('\n')[0] !== 'PASS') {
        fail(`${action} ${width}x${height} reported failure: ${readFileSync(resultPath, 'utf8').trim()}`);
      }
      const lines = readFileSync(samplesPath, 'utf8').split('\n').filter((line) => line.trim());
      allSamples.push(...lines.map((line) => JSON.parse(line)));
    } finally {
      await stopChild(config, child);
    }
  }
  if (allSamples.length !== 30) fail(`${action} ${width}x${height} produced ${allSamples.length} samples`);
  return allSamples;
}

function jcs(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(',')}}`;
  fail('evidence contains a non-canonical value');
}

function p95(durations) {
  const ordered = [...durations].sort((left, right) => left - right);
  return ordered[28];
}

function validateAndWriteEvidence(config, samples) {
  const expectedGroups = new Map();
  for (const [width, height] of VIEWPORTS) {
    for (const action of ACTIONS) expectedGroups.set(`${width}x${height}:${action}`, []);
  }
  const sampleIds = new Set();
  for (const sample of samples) {
    if (sample.schemaVersion !== 1 || !SHA256.test(sample.artifactSha256) || sample.artifactSha256 !== config.artifactSha256 || sample.commitSha !== config.commitSha || sample.appVersion !== config.appVersion || sample.platform !== config.platform || sample.mountedGpuRows !== 10 || sample.mountedRowIdsSha256 !== ROW_IDS_SHA256 || !Number.isSafeInteger(sample.durationUs) || sample.durationUs < 1 || sample.durationUs > 10_000_000 || !Number.isInteger(sample.ordinal) || sample.ordinal < 1 || sample.ordinal > 30 || !sampleIds.add(sample.sampleId)) fail('raw sample binding, row hash, duration, or UUID validation failed');
    const group = expectedGroups.get(`${sample.viewportWidth}x${sample.viewportHeight}:${sample.action}`);
    if (!group) fail(`unexpected sample group ${sample.viewportWidth}x${sample.viewportHeight}:${sample.action}`);
    group.push(sample);
  }
  if (samples.length !== 300 || [...expectedGroups.values()].some((group) => group.length !== 30)) fail('exactly 30 samples are required for every 10 groups');
  const groups = [...expectedGroups.entries()].map(([key, group]) => {
    const [viewport, action] = key.split(':');
    const [viewportWidth, viewportHeight] = viewport.split('x').map(Number);
    const ordered = [...group].sort((left, right) => left.ordinal - right.ordinal);
    if (ordered.some((sample, index) => sample.ordinal !== index + 1)) fail(`ordinal sequence is invalid for ${key}`);
    const p95Us = p95(ordered.map((sample) => sample.durationUs));
    if (!(p95Us < 100_000)) fail(`${key} p95 is ${p95Us}us`);
    return { platform: config.platform, appVersion: config.appVersion, commitSha: config.commitSha, artifactSha256: config.artifactSha256, viewportWidth, viewportHeight, action, p95Us };
  }).sort((left, right) => left.viewportWidth - right.viewportWidth || left.action.localeCompare(right.action));
  const evidenceWithoutHash = {
    schemaVersion: 1,
    platform: config.platform,
    appVersion: config.appVersion,
    commitSha: config.commitSha,
    artifactSha256: config.artifactSha256,
    fixtureId: 'gpu-selector-perf-10-v1',
    fixtureSha256: FIXTURE_SHA256,
    thresholdUs: 100_000,
    samplesPerActionViewport: 30,
    samples: [...samples].sort((left, right) => left.viewportWidth - right.viewportWidth || left.action.localeCompare(right.action) || left.ordinal - right.ordinal),
    groups,
  };
  const evidenceSha256 = createHash('sha256').update(`${jcs(evidenceWithoutHash)}\n`).digest('hex');
  const evidence = { ...evidenceWithoutHash, evidenceSha256 };
  const evidencePath = join(config.outputRoot, 'gpu-selector-perf-v1', config.commitSha, config.appVersion, config.platform, config.artifactSha256, 'gpu-selector-perf-10-v1__1280x720__1440x900.json');
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${jcs(evidence)}\n`, 'utf8');
  return { evidencePath, evidenceSha256, groups };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const runRoot = join(config.outputRoot, '.selector-perf-runs', `${config.platform}-${config.commitSha}-${config.artifactSha256}`);
  mkdirSync(runRoot, { recursive: true });
  const macInputHelper = config.platform === 'macos-arm64' ? createMacInputHelper() : null;
  try {
    const samples = [];
    for (const [width, height] of VIEWPORTS) {
      for (const action of ACTIONS) {
        const groupRoot = join(runRoot, `${width}x${height}`, action);
        mkdirSync(groupRoot, { recursive: true });
        samples.push(...await runGroup(config, action, width, height, groupRoot, macInputHelper?.path));
      }
    }
    const evidence = validateAndWriteEvidence(config, samples);
    console.log(JSON.stringify({ platform: config.platform, appVersion: config.appVersion, commitSha: config.commitSha, artifactSha256: config.artifactSha256, sampleCount: samples.length, evidencePath: evidence.evidencePath, evidenceSha256: evidence.evidenceSha256, p95Us: evidence.groups.map((group) => ({ viewport: `${group.viewportWidth}x${group.viewportHeight}`, action: group.action, p95Us: group.p95Us })) }, null, 2));
  } finally {
    macInputHelper?.cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
