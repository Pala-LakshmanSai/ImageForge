import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StudioGpuSwitchState } from '../domain/types';
import { GpuSwitchConsent } from './GpuSwitchConsent';

function pendingSwitch(overrides: Partial<StudioGpuSwitchState> = {}): StudioGpuSwitchState {
  return {
    switchId: '66666666-6666-4666-8666-666666666666',
    oldPodId: 'pod-exact-1',
    oldGpuId: 'NVIDIA GeForce RTX 4090',
    oldGpuDisplayName: 'RTX 4090',
    initialTargetGpuId: 'NVIDIA RTX 5090',
    initialTargetGpuDisplayName: 'RTX 5090',
    requester: { sessionId: '11111111-1111-4111-8111-111111111111', displayName: 'Lakshman' },
    isRequester: false,
    canRespond: true,
    phase: 'pending',
    reason: null,
    requestedAt: '2026-08-03T10:00:00.000Z',
    responseDeadline: '2999-08-03T10:00:30.000Z',
    readyToDeleteAt: null,
    waitingFor: [{ sessionId: '22222222-2222-4222-8222-222222222222', displayName: 'Sujal' }],
    approvedBy: [],
    deniedBy: [],
    batchId: '33333333-3333-4333-8333-333333333333',
    batchOwner: 'Lakshman',
    batchProgress: { completed: 18, total: 450 },
    batchStateAtFinalization: null,
    replacementPodId: null,
    actualTargetGpuId: null,
    ...overrides,
  };
}

describe('GpuSwitchConsent', () => {
  it('opens the required peer dialog with Keep current focused and Escape leaves its banner', async () => {
    render(<GpuSwitchConsent request={pendingSwitch()} dispatch={vi.fn()} />);

    const keep = await screen.findByRole('button', { name: 'Keep current GPU' });
    expect(keep).toHaveFocus();
    expect(screen.getByText('Lakshman is at 18 of 450 images.')).toBeVisible();
    expect(screen.getByText(/later recovery attempt may choose another policy-approved GPU/i)).toBeVisible();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    const trigger = screen.getByRole('button', { name: 'Review GPU switch' });
    expect(trigger).toBeVisible();
    expect(trigger).toHaveFocus();
  });

  it('dispatches only the two labelled peer decisions', async () => {
    const dispatch = vi.fn();
    render(<GpuSwitchConsent request={pendingSwitch()} dispatch={dispatch} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Keep current GPU' }));
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'RESPOND_STUDIO_GPU_SWITCH',
      switchId: '66666666-6666-4666-8666-666666666666',
      decision: 'deny',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Review GPU switch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve switch after this image' }));
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'RESPOND_STUDIO_GPU_SWITCH',
      switchId: '66666666-6666-4666-8666-666666666666',
      decision: 'approve',
    });
  });

  it('shows requester consent progress without peer response controls', () => {
    render(<GpuSwitchConsent request={pendingSwitch({
      isRequester: true,
      canRespond: false,
    })} dispatch={vi.fn()} />);

    expect(screen.getByText('Waiting for Sujal')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Review GPU switch' })).not.toBeInTheDocument();
  });
});
