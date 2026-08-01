import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from './App';
import type { ImageForgeAdapter } from './adapters/imageForgeAdapter';
import { createInitialState } from './domain/reducer';

function immediateAdapter(): ImageForgeAdapter {
  return {
    chooseDestination: async () => '/tmp/imageforge-output',
    runPodLifecycle(onUpdate) {
      onUpdate({ phase: 'ready', progress: 100, detail: 'Model warm', podId: 'pod-ui-test' });
      return () => undefined;
    },
    finishPodStop(onStopped) {
      onStopped();
      return () => undefined;
    },
    validateBatch(onValidated) {
      onValidated();
      return () => undefined;
    },
    runBatchClock() {
      return () => undefined;
    },
  };
}

describe('ImageForge shell', () => {
  it('navigates all five real destinations', async () => {
    const user = userEvent.setup();
    render(<App initialState={createInitialState()} adapter={immediateAdapter()} />);

    for (const [label, heading] of [
      ['Progress', 'The desk is clear.'],
      ['Library', 'Your visual ledger.'],
      ['Usage', 'Know every frame’s cost.'],
      ['Settings', 'Make the desk yours.'],
      ['Create', 'Direct the frame.'],
    ] as const) {
      await user.click(screen.getByRole('button', { name: label }));
      expect(screen.getByRole('heading', { name: heading })).toBeVisible();
    }
  });

  it('runs the critical fake Create-to-Progress flow with no backend', async () => {
    const user = userEvent.setup();
    render(<App initialState={createInitialState()} adapter={immediateAdapter()} />);

    await user.click(screen.getByRole('button', { name: 'Load sample brief' }));
    await user.click(screen.getByRole('button', { name: /Choose output folder/i }));
    await user.click(screen.getAllByRole('button', { name: 'Start GPU' })[0]);

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate 24 ordered images/i })).toBeEnabled());
    const start = screen.getByRole('button', { name: /Generate 24 ordered images/i });
    await user.click(start);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Atlas of Quiet Work' })).toBeVisible());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause after frame' })).toBeVisible());
    await user.click(screen.getByRole('button', { name: 'Pause after frame' }));
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
  });
});
