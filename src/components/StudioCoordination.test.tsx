import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StudioStopState } from '../domain/types';
import { StudioCoordination } from './StudioCoordination';

function pendingStop(overrides: Partial<StudioStopState> = {}): StudioStopState {
  return {
    phase: 'pending',
    requestId: '44444444-4444-4444-8444-444444444444',
    podId: 'pod-exact-1',
    gpuDisplayName: 'RTX 4090',
    requester: { sessionId: '11111111-1111-4111-8111-111111111111', displayName: 'Lakshman' },
    isRequester: false,
    canRespond: true,
    waitingFor: [{ sessionId: '22222222-2222-4222-8222-222222222222', displayName: 'Sujal' }],
    approvedBy: [],
    deniedBy: [],
    responseDeadline: '2999-08-03T10:00:30.000Z',
    finalizationExpiresAt: null,
    finalizationId: null,
    reason: null,
    message: null,
    retryable: false,
    blockedByBatch: null,
    ...overrides,
  };
}

describe('StudioCoordination', () => {
  it('focuses a required foreground session and exposes both explicit decisions', () => {
    const dispatch = vi.fn();
    render(<StudioCoordination stop={pendingStop()} dispatch={dispatch} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveFocus();
    expect(screen.getByText('Lakshman wants to stop RTX 4090')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep GPU running' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve stop' }));
    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: 'RESPOND_STUDIO_STOP',
      requestId: '44444444-4444-4444-8444-444444444444',
      decision: 'deny',
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: 'RESPOND_STUDIO_STOP',
      requestId: '44444444-4444-4444-8444-444444444444',
      decision: 'approve',
    });
  });

  it('does not prompt a background or otherwise non-required session', () => {
    render(<StudioCoordination stop={pendingStop({ canRespond: false })} dispatch={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Keep GPU running' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve stop' })).not.toBeInTheDocument();
    expect(screen.getByText(/No response is required from this app session/i)).toBeVisible();
  });

  it('deduplicates one required principal with multiple foreground sessions in requester copy', () => {
    render(<StudioCoordination stop={pendingStop({
      isRequester: true,
      canRespond: false,
      waitingFor: [
        { sessionId: '22222222-2222-4222-8222-222222222222', displayName: 'Sujal' },
        { sessionId: '33333333-3333-4333-8333-333333333333', displayName: 'Sujal' },
      ],
    })} dispatch={vi.fn()} />);

    expect(screen.getByText('Waiting for Sujal')).toBeVisible();
    expect(screen.queryByText(/Sujal, Sujal/)).not.toBeInTheDocument();
  });

  it('lets the requester cancel while waiting without hiding generation semantics', () => {
    const dispatch = vi.fn();
    render(<StudioCoordination stop={pendingStop({ isRequester: true, canRespond: false })} dispatch={dispatch} />);

    expect(screen.getByText(/Generation remains available/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel stop request' }));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'CANCEL_STUDIO_STOP',
      requestId: '44444444-4444-4444-8444-444444444444',
    });
  });
});
