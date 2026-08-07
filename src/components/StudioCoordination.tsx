import { AlertTriangle, CheckCircle2, Clock3, ShieldCheck, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppAction, StudioStopState } from '../domain/types';
import { Button } from './primitives';

interface StudioCoordinationProps {
  stop: StudioStopState;
  dispatch: (action: AppAction) => void;
}

function useCountdown(deadline: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return useMemo(() => {
    if (deadline === null) return null;
    const remaining = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1_000));
    if (remaining === 0) return 'Response window closing';
    return `${remaining}s to respond`;
  }, [deadline, now]);
}

function names(stop: StudioStopState): string {
  return [...new Set(stop.waitingFor.map((participant) => participant.displayName))].join(', ') || 'active editors';
}

export function StudioCoordination({ stop, dispatch }: StudioCoordinationProps) {
  const surfaceRef = useRef<HTMLElement>(null);
  const countdown = useCountdown(stop.phase === 'pending' ? stop.responseDeadline : stop.finalizationExpiresAt);
  const isApprover = stop.phase === 'pending' && stop.canRespond && stop.requestId !== null;

  useEffect(() => {
    if (isApprover) surfaceRef.current?.focus();
  }, [isApprover, stop.requestId]);

  if (stop.phase === 'idle') return null;

  if (isApprover) {
    return (
      <section
        ref={surfaceRef}
        className="studio-coordination studio-coordination--approval"
        role="alert"
        aria-live="assertive"
        tabIndex={-1}
      >
        <span className="studio-coordination__icon"><Users size={20} /></span>
        <div className="studio-coordination__copy">
          <p className="eyebrow">Shared GPU decision · {countdown}</p>
          <strong>{stop.requester?.displayName ?? 'Another editor'} wants to stop {stop.gpuDisplayName ?? 'the GPU'}</strong>
          <span>
            Approve only if you do not need the warm GPU. Exact target <code>{stop.podId}</code>; no batch is active right now.
          </span>
        </div>
        <div className="studio-coordination__actions">
          <Button
            tone="secondary"
            onClick={() => dispatch({ type: 'RESPOND_STUDIO_STOP', requestId: stop.requestId!, decision: 'deny' })}
          >
            Keep GPU running
          </Button>
          <Button
            tone="danger"
            onClick={() => dispatch({ type: 'RESPOND_STUDIO_STOP', requestId: stop.requestId!, decision: 'approve' })}
          >
            Approve stop
          </Button>
        </div>
      </section>
    );
  }

  const blocked = stop.blockedByBatch;
  const terminal = ['blocked', 'denied', 'expired', 'cancelled', 'failed'].includes(stop.phase);
  const dismissible = terminal || stop.phase === 'stopped';
  const title = stop.phase === 'checking'
    ? 'Checking for an active batch before stopping'
    : stop.phase === 'blocked'
      ? `${blocked?.owner ?? 'Another editor'} has an active batch`
      : stop.phase === 'pending'
        ? stop.isRequester
          ? `Waiting for ${names(stop)}`
          : `${stop.requester?.displayName ?? 'Another editor'} is waiting for approvals`
        : stop.phase === 'approved'
          ? 'Every active editor approved'
          : stop.phase === 'finalizing'
            ? 'Exact GPU termination is being finalized'
            : stop.phase === 'denied'
              ? 'GPU stays online'
              : stop.phase === 'expired'
                ? 'Approval window expired'
            : stop.phase === 'cancelled'
                  ? stop.reason === 'generation_started' ? 'Generation kept the GPU online' : 'Stop request cancelled'
                  : stop.phase === 'stopped'
                    ? 'GPU stop confirmed'
                    : 'GPU stop needs attention';
  const detail = stop.phase === 'checking'
    ? 'ImageForge is checking the durable batch lease and every foreground editor. No RunPod termination has been sent.'
    : stop.phase === 'blocked'
      ? `${blocked?.completed ?? 0} of ${blocked?.total ?? 0} images are complete. An active batch is an unconditional stop veto, including for its owner.`
      : stop.phase === 'pending'
        ? stop.isRequester
          ? `${countdown ?? 'Awaiting responses'}. Generation remains available and will cancel this pending request safely.`
          : `No response is required from this app session. ${names(stop)} must decide; generation remains available while approval is pending.`
        : stop.phase === 'approved'
          ? 'Revalidating the exact Pod and consuming the short worker guard before one RunPod DELETE.'
          : stop.phase === 'finalizing'
            ? 'New generation is briefly blocked while the single-use deletion guard is active.'
            : stop.phase === 'denied'
              ? `${stop.deniedBy.map((peer) => peer.displayName).join(', ') || 'Another editor'} chose to keep the warm GPU available.`
              : stop.phase === 'expired'
                ? 'Not every foreground editor responded in time. No termination was sent.'
                : stop.phase === 'cancelled'
                  ? stop.reason === 'generation_started'
                    ? 'A batch started before final authorization. The stop request was cancelled atomically and generation continues.'
                    : 'The shared GPU remains available; no termination was sent.'
                  : stop.phase === 'stopped'
                    ? stop.message ?? 'The exact confirmed GPU is offline. Local files are unchanged.'
                    : stop.message ?? 'The GPU remains running. Refresh shared status before trying again.';

  return (
    <section
      ref={surfaceRef}
      className={`studio-coordination studio-coordination--${terminal ? 'warning' : 'progress'}`}
      role="status"
      aria-live="polite"
      tabIndex={-1}
    >
      <span className="studio-coordination__icon">
        {terminal ? <AlertTriangle size={20} /> : stop.phase === 'approved' || stop.phase === 'finalizing' ? <ShieldCheck size={20} /> : stop.phase === 'pending' ? <Clock3 size={20} /> : <CheckCircle2 size={20} />}
      </span>
      <div className="studio-coordination__copy">
        <p className="eyebrow">Coordinated GPU stop{countdown && stop.phase !== 'pending' ? ` · ${countdown}` : ''}</p>
        <strong>{title}</strong>
        <span>{detail}</span>
        {stop.podId ? <code>{stop.gpuDisplayName ?? 'GPU'} · {stop.podId}</code> : null}
      </div>
      <div className="studio-coordination__actions">
        {stop.phase === 'pending' && stop.isRequester && stop.requestId ? (
          <Button tone="secondary" onClick={() => dispatch({ type: 'CANCEL_STUDIO_STOP', requestId: stop.requestId! })}>
            Cancel stop request
          </Button>
        ) : null}
        {dismissible ? (
          <Button tone="secondary" onClick={() => dispatch({ type: 'CLEAR_STUDIO_STOP' })}>
            Dismiss
          </Button>
        ) : null}
      </div>
    </section>
  );
}
