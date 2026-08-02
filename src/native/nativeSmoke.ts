import { invoke } from '@tauri-apps/api/core';

const SMOKE_TIMEOUT_MS = 45_000;

function visibleText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

async function waitFor<T>(description: string, read: () => T | null, timeoutMs = SMOKE_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw new Error(`Native smoke timed out waiting for ${description}.`);
}

function buttonMatching(pattern: RegExp): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => {
      const name = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''} ${visibleText(button)}`.trim();
      return !button.disabled && pattern.test(name);
    }) ?? null;
}

async function clickButton(description: string, pattern: RegExp): Promise<void> {
  const button = await waitFor(description, () => buttonMatching(pattern));
  button.click();
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function fill(description: string, selector: string, value: string): Promise<void> {
  const input = await waitFor(description, () => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector));
  setInputValue(input, value);
}

async function attachReference(): Promise<void> {
  const input = await waitFor('reference-image input', () => document.querySelector<HTMLInputElement>('#reference-files'));
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZgpcAAAAASUVORK5CYII=';
  const bytes = Uint8Array.from(window.atob(pngBase64), (character) => character.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], 'smoke-reference.png', { type: 'image/png' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor('reference preview card', () => {
    const grid = document.querySelector('[aria-label="1 batch references"]');
    return grid?.textContent?.includes('smoke-reference.png') ? true : null;
  });
}

async function record(passed: boolean, detail: string): Promise<void> {
  await invoke('native_smoke_result', { passed, detail: detail.slice(0, 240) });
}

/**
 * Runs only when the packaged binary is launched with IMAGEFORGE_NATIVE_SMOKE=1.
 * The normal desktop path never imports a fake adapter and never executes this
 * flow. It exercises the bundled webview through the same buttons a user sees.
 */
export async function runNativeSmoke(): Promise<void> {
  try {
    await fill('first-run name field', 'input[placeholder="Lakshman or Sujal"]', 'Smoke Editor');
    await clickButton('first setup continue', /^Continue$/);
    await fill('RunPod API key field', 'input[aria-label="RunPod API key"]', 'smoke-api-key-1234');
    await clickButton('RunPod setup continue', /^Continue$/);
    await fill('worker token field', 'input[aria-label="Worker token"]', 'smoke-worker-token-1234');
    await clickButton('worker setup continue', /^Continue$/);
    await clickButton('downloads folder chooser', /Pictures\/ImageForge/);
    await clickButton('connection test', /Run connection test/);
    await waitFor('setup dialog to close', () => document.querySelector('[role="dialog"]') === null ? true : null);
    await clickButton('sample brief', /Load sample brief/);
    await clickButton('output folder chooser', /Choose output folder/);
    await attachReference();
    await clickButton('reference removal', /Remove smoke-reference\.png/);
    await waitFor('reference removal to finish', () => document.querySelector('[aria-label="1 batch references"]') === null ? true : null);
    await attachReference();
    await clickButton('fake Start GPU control', /^Start GPU$/);
    await waitFor('fake GPU readiness', () => buttonMatching(/Stop GPU/) ? true : null);
    await clickButton('fake batch launch', /Generate \d+ ordered images/);
    await clickButton('folder reveal control', /Reveal folder/);
    await record(true, 'onboarding, reference add/remove/re-add, fake GPU lifecycle, fake batch launch, and folder reveal passed');
  } catch (error) {
    await record(false, error instanceof Error ? error.message : 'Native smoke failed.');
  }
}
