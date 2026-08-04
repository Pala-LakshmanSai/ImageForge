import { AlertTriangle, CheckCircle2, Clock3, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppAction, StudioGpuSwitchState } from '../domain/types';
import { DialogPortal } from './DialogPortal';
import { Button } from './primitives';

interface GpuSwitchConsentProps {
  readonly request: StudioGpuSwitchState | null;
  readonly dispatch: (action: AppAction) => void;
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
    return remaining === 0 ? 'Response window closing' : `${remaining}s to respond`;
  }, [deadline, now]);
}

function waitingNames(request: StudioGpuSwitchState): string {
  return [...new Set(request.waitingFor.map((participant) => participant.displayName))].join(', ')
    || 'active editors';
}

function batchCopy(request: StudioGpuSwitchState): string {
  if (request.batchOwner === null) return 'No batch is active; the replacement will still remain paused.';
  if (request.batchProgress === null) return `${request.batchOwner} owns the current batch.`;
  return `${request.batchOwner} is at ${request.batchProgress.completed} of ${request.batchProgress.total} images.`;
}

function statusCopy(request: StudioGpuSwitchState): { title: string; detail: string; attention: boolean } {
  if (request.phase === 'pending') {
    return request.isRequester
      ? {
          title: `Waiting for ${waitingNames(request)}`,
          detail: 'The current GPU remains online. No provider deletion has been authorized.',
          attention: false,
        }
      : request.canRespond
        ? {
            title: `${request.requester.displayName} requested a GPU replacement`,
            detail: `Review ${request.oldGpuDisplayName} → ${request.initialTargetGpuDisplayName} before the response window closes.`,
            attention: true,
          }
        : {
            title: 'GPU replacement is waiting for another editor',
            detail: 'This session has no pending response. The current GPU remains online.',
            attention: false,
          };
  }
  if (request.phase === 'approved') return {
    title: 'Every required editor approved the switch',
    detail: 'The requester must explicitly continue. The current image and local queue remain protected.',
    attention: false,
  };
  if (request.phase === 'pausing') return {
    title: 'Finishing the current image',
    detail: 'The batch is moving to its durable pause boundary before any Pod is deleted.',
    attention: false,
  };
  if (request.phase === 'ready_to_delete') return {
    title: 'Worker is safely paused',
    detail: 'The requester must recheck the target before permanently terminating the old Pod.',
    attention: false,
  };
  if (request.phase === 'delete_intent') return {
    title: 'Old GPU deletion is authorized',
    detail: 'The replacement cannot be created until native RunPod evidence proves the old Pod absent.',
    attention: true,
  };
  if (request.phase === 'replacement_ready') return {
    title: 'Replacement worker is ready',
    detail: 'The batch and local queue remain paused until the requester explicitly completes and later resumes.',
    attention: false,
  };
  return {
    title: 'GPU switch needs attention',
    detail: 'The worker could not reach its pause fixed point. No provider mutation will retry automatically.',
    attention: true,
  };
}

export function GpuSwitchConsent({ request, dispatch }: GpuSwitchConsentProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const lastPromptedSwitchRef = useRef<string | null>(null);
  const countdown = useCountdown(request?.phase === 'pending' ? request.responseDeadline : null);

  useEffect(() => {
    if (request?.phase !== 'pending' || !request.canRespond) {
      setDialogOpen(false);
      return;
    }
    if (lastPromptedSwitchRef.current === request.switchId) return;
    lastPromptedSwitchRef.current = request.switchId;
    triggerRef.current?.focus();
    setDialogOpen(true);
  }, [request?.canRespond, request?.phase, request?.switchId]);

  if (request === null) return null;
  const status = statusCopy(request);
  const respond = (decision: 'approve' | 'deny') => {
    setDialogOpen(false);
    dispatch({ type: 'RESPOND_STUDIO_GPU_SWITCH', switchId: request.switchId, decision });
  };

  return (
    <>
      <section
        className={`studio-coordination ${status.attention ? 'studio-coordination--approval' : 'studio-coordination--progress'}`}
        role={request.canRespond ? 'alert' : 'status'}
        aria-live={request.canRespond ? 'assertive' : 'polite'}
      >
        <span className="studio-coordination__icon" aria-hidden="true">
          {status.attention ? <AlertTriangle size={20} /> : request.phase === 'pending' ? <Clock3 size={20} /> : <CheckCircle2 size={20} />}
        </span>
        <div className="studio-coordination__copy">
          <p className="eyebrow">
            Coordinated GPU switch
            {countdown ? <span aria-hidden="true"> · {countdown}</span> : null}
          </p>
          <strong>{status.title}</strong>
          <span>{status.detail}</span>
          <code>{request.oldGpuDisplayName} → {request.initialTargetGpuDisplayName}</code>
        </div>
        <div className="studio-coordination__actions">
          {request.phase === 'pending' && request.canRespond ? (
            <button
              ref={triggerRef}
              className="button button--secondary"
              type="button"
              onClick={() => setDialogOpen(true)}
            >
              <span>Review GPU switch</span>
            </button>
          ) : null}
        </div>
      </section>

      {dialogOpen && request.phase === 'pending' && request.canRespond ? (
        <DialogPortal
          backdropClassName="modal-backdrop"
          surfaceClassName="modal gpu-switch-consent"
          labelledBy="gpu-switch-consent-title"
          describedBy="gpu-switch-consent-detail"
          role="alertdialog"
          onRequestClose={() => setDialogOpen(false)}
        >
          <div className="modal__symbol" aria-hidden="true"><Users size={23} /></div>
          <p className="eyebrow">Shared GPU decision · {countdown ?? 'response required'}</p>
          <h2 id="gpu-switch-consent-title">
            {request.requester.displayName} wants to replace {request.oldGpuDisplayName}
          </h2>
          <p id="gpu-switch-consent-detail">
            Approving lets the current image finish, then pauses the batch and local queue before the old Pod is permanently terminated. The proposed first target is {request.initialTargetGpuDisplayName}.
          </p>
          <ul className="gpu-switch-consent__facts">
            <li>{batchCopy(request)}</li>
            <li>The same network volume and completed images stay in place.</li>
            <li>A later recovery attempt may choose another policy-approved GPU only after the old Pod is gone.</li>
            <li>Approval does not resume the batch or local queue.</li>
          </ul>
          <div className="modal__actions">
            <Button data-autofocus tone="secondary" onClick={() => respond('deny')}>
              Keep current GPU
            </Button>
            <Button tone="danger" onClick={() => respond('approve')}>
              Approve switch after this image
            </Button>
          </div>
        </DialogPortal>
      ) : null}
    </>
  );
}
