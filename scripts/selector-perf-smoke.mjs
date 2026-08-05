#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    run('clang', ['-O2', sourcePath, '-framework', 'CoreGraphics', '-framework', 'CoreFoundation', '-o', binaryPath]);
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

function macClick(pid, location, inputHelperPath, focus = true) {
  if (focus) macFocus(pid);
  run(inputHelperPath, ['click', String(Math.round(location.x)), String(Math.round(location.y))]);
}

function macKey(pid, keyCode, inputHelperPath, focus = true) {
  if (focus) macFocus(pid);
  run(inputHelperPath, ['key', String(keyCode)]);
}

const WINDOWS_HELPER = `
using System;
using System.Runtime.InteropServices;
public static class ImageForgePerfInput {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT_UNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUT_UNION u; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1, MOUSE_DOWN = 0x0002, MOUSE_UP = 0x0004, KEY_UP = 0x0002;
  public static bool FocusWindow(IntPtr hWnd) {
    ShowWindow(hWnd, 9);
    BringWindowToTop(hWnd);
    return SetForegroundWindow(hWnd);
  }
  public static void Click() {
    var inputs = new INPUT[2];
    inputs[0].type = INPUT_MOUSE;
    inputs[0].u.mi.dwFlags = MOUSE_DOWN;
    inputs[1].type = INPUT_MOUSE;
    inputs[1].u.mi.dwFlags = MOUSE_UP;
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>()) != inputs.Length) throw new InvalidOperationException("SendInput mouse failed");
  }
  public static void Key(ushort virtualKey) {
    var inputs = new INPUT[2];
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].u.ki.wVk = virtualKey;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].u.ki.wVk = virtualKey;
    inputs[1].u.ki.dwFlags = KEY_UP;
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>()) != inputs.Length) throw new InvalidOperationException("SendInput keyboard failed");
  }
}`;

const WINDOWS_SESSION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
${WINDOWS_HELPER}
'@
$handle = [IntPtr]::Zero
function Reply([string]$message) {
  [Console]::Out.WriteLine($message)
  [Console]::Out.Flush()
}
Reply 'READY'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $parts = $line.Split('|')
    switch ($parts[0]) {
      'attach' {
        if ($parts.Count -ne 2) { throw 'process ID is invalid' }
        $pidValue = [int]$parts[1]
        $deadline = (Get-Date).AddSeconds(30)
        do {
          $process = Get-Process -Id $pidValue -ErrorAction Stop
          $handle = $process.MainWindowHandle
          if ($handle -eq 0) { Start-Sleep -Milliseconds 50 }
        } while ($handle -eq 0 -and (Get-Date) -lt $deadline)
        if ($handle -eq 0) { throw 'main window is unavailable' }
        if (-not [ImageForgePerfInput]::FocusWindow($handle)) { throw 'main window could not be focused' }
        if ([ImageForgePerfInput]::GetForegroundWindow() -ne $handle) { throw 'main window could not be focused' }
        Reply 'OK'
        break
      }
      'focus' {
        if ($handle -eq 0) { throw 'main window is unavailable' }
        if (-not [ImageForgePerfInput]::FocusWindow($handle)) { throw 'main window could not be focused' }
        if ([ImageForgePerfInput]::GetForegroundWindow() -ne $handle) { throw 'main window could not be focused' }
        Reply 'OK'
        break
      }
      'metrics' {
        if ($handle -eq 0) { throw 'main window is unavailable' }
        $rect = New-Object ImageForgePerfInput+RECT
        if (-not [ImageForgePerfInput]::GetWindowRect($handle, [ref]$rect)) { throw 'main window metrics are unavailable' }
        Reply ("METRICS|{0}|{1}|{2}|{3}" -f $rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
        break
      }
      'click' {
        if ($handle -eq 0) { throw 'main window is unavailable' }
        if ($parts.Count -ne 3) { throw 'click coordinates are invalid' }
        if (-not [ImageForgePerfInput]::SetCursorPos([int]$parts[1], [int]$parts[2])) { throw 'cursor could not be positioned' }
        [ImageForgePerfInput]::Click()
        Reply 'OK'
        break
      }
      'key' {
        if ($handle -eq 0) { throw 'main window is unavailable' }
        if ($parts.Count -ne 2) { throw 'key code is invalid' }
    [ImageForgePerfInput]::Key([uint16]$parts[1])
        Reply 'OK'
        break
      }
      'quit' {
        Reply 'BYE'
        exit 0
      }
      default { throw "unknown input command: $($parts[0])" }
    }
  } catch {
    Reply ("ERR|{0}" -f $_.Exception.Message.Replace([char]13, ' ').Replace([char]10, ' '))
  }
}
`;

class WindowsInputSession {
  static async start() {
    const session = new WindowsInputSession();
    await session.ready;
    return session;
  }

  constructor() {
    this.child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_SESSION_SCRIPT,
    ], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.closed = false;
    this.buffer = '';
    this.pending = [];
    this.stderr = '';
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.child.stdout.on('data', (chunk) => this.consumeOutput(chunk.toString()));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
    this.child.once('error', (error) => {
      this.rejectReady(error);
      this.rejectPending(error);
    });
    this.child.once('exit', (code, signal) => {
      const detail = new Error(`Windows input session exited ${code ?? `by ${signal}`}${this.stderr ? `: ${this.stderr.trim()}` : ''}`);
      if (!this.readySettled) this.rejectReady(detail);
      this.rejectPending(detail);
    });
    this.readySettled = false;
  }

  consumeOutput(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!this.readySettled) {
        if (line !== 'READY') {
          this.rejectReady(new Error(`Windows input session did not initialize: ${line}`));
          return;
        }
        this.readySettled = true;
        this.resolveReady();
        continue;
      }
      const request = this.pending.shift();
      if (request) request.resolve(line);
    }
  }

  rejectPending(error) {
    for (const request of this.pending.splice(0)) request.reject(error);
  }

  async request(command) {
    await this.ready;
    if (this.closed) fail('Windows input session is closed');
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.push({ resolve: resolvePromise, reject: rejectPromise });
      this.child.stdin.write(`${command}\n`, (error) => {
        if (error) {
          const request = this.pending.pop();
          request?.reject(error);
        }
      });
    });
  }

  async focus() {
    const response = await this.request('focus');
    if (response !== 'OK') fail(`Windows input focus failed: ${response}`);
  }

  async attach(pid) {
    const response = await this.request(`attach|${pid}`);
    if (response !== 'OK') fail(`Windows input attach failed: ${response}`);
  }

  async metrics() {
    const response = await this.request('metrics');
    const values = response.split('|').slice(1).map((value) => Number(value));
    if (!response.startsWith('METRICS|') || values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
      fail(`invalid Windows input metrics: ${response}`);
    }
    return { left: values[0], top: values[1], width: values[2], height: values[3] };
  }

  async click(location) {
    const response = await this.request(`click|${Math.round(location.x)}|${Math.round(location.y)}`);
    if (response !== 'OK') fail(`Windows input click failed: ${response}`);
  }

  async key(virtualKey) {
    const response = await this.request(`key|${virtualKey}`);
    if (response !== 'OK') fail(`Windows input key failed: ${response}`);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end('quit\n');
    } catch {
      // The helper may already have exited with the application.
    }
    await new Promise((resolvePromise) => {
      if (this.child.exitCode !== null) {
        resolvePromise();
        return;
      }
      const timeout = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill();
        resolvePromise();
      }, 1_000);
      this.child.once('exit', () => {
        clearTimeout(timeout);
        resolvePromise();
      });
    });
  }
}

function windowsCommand(pid, action, focus = true) {
  const script = `Add-Type @'
${WINDOWS_HELPER}
'@
$process = Get-Process -Id ${pid} -ErrorAction Stop
$handle = $process.MainWindowHandle
if ($handle -eq 0) { throw 'main window is unavailable' }
${focus ? '[ImageForgePerfInput]::FocusWindow($handle) | Out-Null\nif ([ImageForgePerfInput]::GetForegroundWindow() -ne $handle) { throw \'main window could not be focused\' }' : ''}
${action}`;
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

function windowsMetrics(pid, focus = true) {
  const output = windowsCommand(pid, '$rect = New-Object ImageForgePerfInput+RECT\n[ImageForgePerfInput]::GetWindowRect($handle, [ref]$rect) | Out-Null\nWrite-Output ("{0},{1},{2},{3}" -f $rect.Left,$rect.Top,($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))', focus);
  const values = output.split(',').map((value) => Number(value));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) fail(`invalid Windows window metrics: ${output}`);
  return { left: values[0], top: values[1], width: values[2], height: values[3] };
}

function windowsClick(pid, location, focus = true) {
  windowsCommand(pid, `[ImageForgePerfInput]::SetCursorPos(${Math.round(location.x)}, ${Math.round(location.y)}) | Out-Null\n[ImageForgePerfInput]::Click()`, focus);
}

function windowsKey(pid, virtualKey, focus = true) {
  windowsCommand(pid, `[ImageForgePerfInput]::Key(${virtualKey})`, focus);
}

function windowMetrics(platform, pid, focus = true) {
  return platform === 'macos-arm64' ? macMetrics(pid) : windowsMetrics(pid, focus);
}

function focusWindow(platform, pid) {
  if (platform === 'macos-arm64') macFocus(pid);
  else windowsCommand(pid, '');
}

function locationForMetrics(metrics, kind) {
  const center = { x: metrics.left + metrics.width / 2, y: metrics.top + metrics.height / 2 };
  const locations = {
    center,
    // The warm-open harness intentionally renders a full-frame transparent
    // close target. Use its center rather than a title-bar-relative point so
    // native smoke coordinates remain valid across frame metrics and DPI.
    close: center,
    // The warm-up target covers the full content frame. The centered point is
    // inside that frame on both target window implementations; frame-edge
    // coordinates can land in the native resize border instead.
    warmup: center,
    refresh: { x: metrics.left + 80, y: metrics.top + 55 },
  };
  const location = locations[kind];
  if (!location) fail(`unknown click target ${kind}`);
  return location;
}

function clickLocation(platform, pid, kind, focus = true) {
  // Resize is asynchronous in the renderer. Re-read the native frame for
  // every click so titlebar/content movement cannot send a sample to stale
  // coordinates.
  const metrics = windowMetrics(platform, pid, focus);
  return locationForMetrics(metrics, kind);
}

async function clickAt(platform, pid, location, macInputHelperPath, focus = false, inputSession = null) {
  // A measured click must not query the window or launch a helper process
  // after the native arm is accepted. Those queries can trigger a focus
  // lifecycle transition and invalidate the one-use authorization.
  if (platform === 'macos-arm64') {
    macClick(pid, location, macInputHelperPath, focus);
  } else if (inputSession !== null) {
    await inputSession.click(location);
  } else {
    windowsClick(pid, location, focus);
  }
}

async function clickTarget(platform, pid, kind, macInputHelperPath, focus = true, inputSession = null) {
  let location;
  if (inputSession !== null) {
    if (focus) await inputSession.focus();
    location = locationForMetrics(await inputSession.metrics(), kind);
  } else {
    location = clickLocation(platform, pid, kind, focus);
  }
  await clickAt(platform, pid, location, macInputHelperPath, focus, inputSession);
  return location;
}

async function prepareMeasuredClick(platform, pid, kind, inputSession = null) {
  if (inputSession !== null) {
    await inputSession.focus();
    return locationForMetrics(await inputSession.metrics(), kind);
  }
  const location = clickLocation(platform, pid, kind, true);
  // macOS metric collection reads the frame but does not activate the app;
  // finish foregrounding before the arm request. WindowsMetrics already does
  // this in the same pre-arm helper invocation.
  if (platform === 'macos-arm64') focusWindow(platform, pid);
  return location;
}

async function sendKey(platform, pid, key, macInputHelperPath, focus = true, inputSession = null) {
  if (platform === 'macos-arm64') {
    const codes = { up: 126, down: 125, space: 49 };
    macKey(pid, codes[key], macInputHelperPath, focus);
  } else {
    const codes = { up: 0x26, down: 0x28, space: 0x20 };
    if (inputSession !== null) await inputSession.key(codes[key]);
    else windowsKey(pid, codes[key], focus);
  }
}

function waitForFile(path, timeoutMs, child, description, logPath) {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (existsSync(path)) {
        resolvePromise();
        return;
      }
      if (child.exitCode !== null) {
        reject(new Error(`${description} process exited ${child.exitCode} before its result was written; application log tail:\n${logTail(logPath)}`));
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`${description} timed out waiting for ${path}; application log tail:\n${logTail(logPath)}`));
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

async function waitForSamples(path, count, child, description, logPath) {
  const deadline = Date.now() + 15_000;
  while (sampleCount(path) < count) {
    if (child.exitCode !== null) fail(`${description} exited ${child.exitCode} before sample ${count}; application log tail:\n${logTail(logPath)}`);
    if (Date.now() >= deadline) fail(`${description} timed out after ${sampleCount(path)} samples; expected ${count}; application log tail:\n${logTail(logPath)}`);
    await sleep(100);
  }
}

function logOccurrences(path, needle) {
  if (!existsSync(path)) return 0;
  const log = readFileSync(path, 'utf8');
  let count = 0;
  let offset = 0;
  while ((offset = log.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function logTail(path, limit = 4_000) {
  if (!existsSync(path)) return '(application log was not created)';
  const log = readFileSync(path, 'utf8');
  return log.length <= limit ? log : `…${log.slice(-limit)}`;
}

async function waitForArm(logPath, expectedCount, child, description) {
  const needle = 'selector arm accepted';
  // Exact native viewport settling may take the same 30-second startup budget
  // used by windowMetrics; the five-second native arm TTL begins only after
  // this acceptance trace, so waiting here does not weaken the gate.
  const deadline = Date.now() + 30_000;
  while (logOccurrences(logPath, needle) < expectedCount) {
    if (child.exitCode !== null) fail(`${description} exited ${child.exitCode} before native arm ${expectedCount}`);
    if (Date.now() >= deadline) {
      fail(`${description} timed out waiting for native arm ${expectedCount}; application log tail:\n${logTail(logPath)}`);
    }
    await sleep(50);
  }
  // The native trace is written before the invoke promise resumes in the
  // renderer. Give React time to commit the arm-dependent control state before
  // sending the trusted event; otherwise the event can reach a still-disabled
  // QA button even though native input authorization has already succeeded.
  await sleep(100);
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
  writeFileSync(logPath, '', 'utf8');
  const appendLog = (chunk) => {
    const text = chunk.toString();
    log.push(text);
    appendFileSync(logPath, text, 'utf8');
  };
  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);
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
    // Compile and start the persistent PowerShell input session before the
    // app exists. Otherwise a slow Add-Type startup can let the renderer arm
    // and expire its five-second native authorization before the first click.
    let inputSession = null;
    if (config.platform === 'windows-x64') inputSession = await WindowsInputSession.start();
    const child = launch(config, action, width, height, samplesPath, resultPath, logPath);
    let expectedArmCount = 0;
    const waitForNextArm = async () => {
      expectedArmCount += 1;
      await waitForArm(logPath, expectedArmCount, child, `${action} ${width}x${height}`);
    };
    try {
      if (inputSession !== null) await inputSession.attach(child.pid);
      const windowDeadline = Date.now() + 30_000;
      let metrics;
      while (!metrics && Date.now() < windowDeadline) {
        try {
          // The Windows session's attach command has already focused the
          // app. Reading metrics must not refocus it after a renderer arm.
          metrics = windowMetrics(config.platform, child.pid, config.platform === 'macos-arm64');
        } catch {
          await sleep(250);
        }
      }
      if (!metrics) fail(`${action} ${width}x${height} did not create a measurable window`);
      if (config.platform === 'macos-arm64') focusWindow(config.platform, child.pid);
      await sleep(750);

      if (action === 'cold_open') {
        const location = await prepareMeasuredClick(config.platform, child.pid, 'center', inputSession);
        await waitForNextArm();
        // The native arm is invalidated by a focus transition. Coordinates
        // and focus are settled before arm; the measured event must not
        // refocus the window while the one-use authorization is live.
        await clickAt(config.platform, child.pid, location, macInputHelperPath, false, inputSession);
        await waitForFile(resultPath, 20_000, child, `${action} launch ${launchIndex + 1}`, logPath);
      } else if (action === 'warm_open') {
        // Three close/open cycles are intentionally unrecorded warm-ups. The
        // harness explicitly leaves the sheet closed after the third open so
        // the next native arm has one deterministic starting state.
        let measuredLocation;
        for (let warmup = 0; warmup < 3; warmup += 1) {
          await clickTarget(config.platform, child.pid, 'warmup', macInputHelperPath, true, inputSession);
          await sleep(250);
          measuredLocation = await clickTarget(config.platform, child.pid, 'warmup', macInputHelperPath, true, inputSession);
          await sleep(400);
        }
        await sleep(500);
        if (measuredLocation === undefined) fail(`${action} ${width}x${height} did not produce a measured coordinate`);
        for (let ordinal = 1; ordinal <= 30; ordinal += 1) {
          await waitForNextArm();
          await clickAt(config.platform, child.pid, measuredLocation, macInputHelperPath, false, inputSession);
          await waitForSamples(samplesPath, ordinal, child, `${action} ${width}x${height}`, logPath);
          await sleep(250);
        }
        await waitForFile(resultPath, 10_000, child, `${action} ${width}x${height}`, logPath);
      } else if (action === 'refresh_loading') {
        for (let ordinal = 1; ordinal <= 30; ordinal += 1) {
          const location = await prepareMeasuredClick(config.platform, child.pid, 'refresh', inputSession);
          await waitForNextArm();
          await clickAt(config.platform, child.pid, location, macInputHelperPath, false, inputSession);
          await waitForSamples(samplesPath, ordinal, child, `${action} ${width}x${height}`, logPath);
        }
        await waitForFile(resultPath, 10_000, child, `${action} ${width}x${height}`, logPath);
      } else {
        for (let ordinal = 1; ordinal <= 30; ordinal += 1) {
          const key = action === 'keyboard_move'
            ? (ordinal % 2 === 1 ? 'down' : 'up')
            : 'space';
          if (inputSession !== null) await inputSession.focus();
          else focusWindow(config.platform, child.pid);
          await sleep(100);
          await waitForNextArm();
          await sendKey(config.platform, child.pid, key, macInputHelperPath, false, inputSession);
          await waitForSamples(samplesPath, ordinal, child, `${action} ${width}x${height}`, logPath);
        }
        await waitForFile(resultPath, 10_000, child, `${action} ${width}x${height}`, logPath);
      }
      if (readFileSync(resultPath, 'utf8').split('\n')[0] !== 'PASS') {
        fail(`${action} ${width}x${height} reported failure: ${readFileSync(resultPath, 'utf8').trim()}`);
      }
      const lines = readFileSync(samplesPath, 'utf8').split('\n').filter((line) => line.trim());
      allSamples.push(...lines.map((line) => JSON.parse(line)));
    } finally {
      await inputSession?.close();
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
