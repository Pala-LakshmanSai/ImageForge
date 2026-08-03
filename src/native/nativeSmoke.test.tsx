import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';
import { runNativeSmoke } from './nativeSmoke';

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));
const originalFilesDescriptor = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'files',
);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

beforeEach(() => {
  invokeMock.mockClear();
  class TestDataTransfer {
    readonly #files: File[] = [];
    readonly items = { add: (file: File) => { this.#files.push(file); } };
    get files(): FileList { return this.#files as unknown as FileList; }
  }
  vi.stubGlobal('DataTransfer', TestDataTransfer);
  Object.defineProperty(HTMLInputElement.prototype, 'files', {
    configurable: true,
    get() { return (this as HTMLInputElement & { __testFiles?: FileList }).__testFiles ?? null; },
    set(value: FileList | null) {
      (this as HTMLInputElement & { __testFiles?: FileList | null }).__testFiles = value;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalFilesDescriptor) {
    Object.defineProperty(HTMLInputElement.prototype, 'files', originalFilesDescriptor);
  }
});

it('completes the packaged fake workflow through the named Library and Download', async () => {
  render(<App />);

  await runNativeSmoke();

  expect(invokeMock).toHaveBeenCalledWith('native_smoke_result', {
    passed: true,
    detail: expect.stringMatching(/incremental saves \d+->\d+.*named minimal Library/),
  });
}, 60_000);
