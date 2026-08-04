import { BellRing, Clock3 } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { AppAction, AppState } from '../domain/types';
import { Button } from './primitives';

interface QueueAlarmProps {
  state: AppState;
  dispatch: (action: AppAction) => void;
  currentCohortArchived: boolean;
}

/**
 * The queue completion surface stays separate from queue editing so its
 * exactly-once event, explicit acknowledgement, and manual Stop boundary are
 * easy to review and test as one lifecycle.
 */
export function QueueAlarm({ state, dispatch, currentCohortArchived }: QueueAlarmProps) {
  const run = state.queue.document.run;
  const alarm = state.queue.document.alarm;
  if (alarm === null || run?.runnerState !== 'completed') return null;

  const needsReview = alarm.kind === 'attention';
  const title = alarm.state === 'snoozed'
    ? 'Alarm snoozed'
    : alarm.state === 'acknowledged'
      ? (needsReview ? 'Queue review acknowledged' : 'Queue completion acknowledged')
      : needsReview
        ? 'Queue finished — review needed'
        : 'Queue complete';
  const detail = alarm.state === 'snoozed'
    ? 'It will ring once more after 15 minutes. The GPU is still running.'
    : 'The GPU is still running. ImageForge never stops it automatically.';

  const card = (
    <aside className={`queue-alarm-card queue-alarm-card--${alarm.state}`} role={alarm.state === 'ringing' ? 'alert' : 'status'}>
      {alarm.state === 'ringing' ? (
        <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {title}: {detail}
        </span>
      ) : null}
      {alarm.state === 'ringing' ? <BellRing size={20} /> : <Clock3 size={20} />}
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <div className="queue-alarm-card__actions">
        {alarm.state === 'ringing' ? <Button compact tone="secondary" onClick={() => dispatch({ type: 'RING_QUEUE_ALARM' })}>Ring now</Button> : null}
        {alarm.state === 'ringing' && !alarm.snoozeUsed ? <Button compact tone="secondary" onClick={() => dispatch({ type: 'SNOOZE_QUEUE_ALARM' })}>Snooze 15 min</Button> : null}
        {alarm.state !== 'acknowledged' ? <Button compact onClick={() => dispatch({ type: 'DISMISS_QUEUE_ALARM' })}>{alarm.state === 'disarmed' ? 'Acknowledge completion' : 'Dismiss alarm'}</Button> : null}
        {alarm.state === 'acknowledged' && !currentCohortArchived ? <Button compact tone="secondary" onClick={() => dispatch({ type: 'CLEAR_QUEUE_COMPLETED' })}>Clear completed from queue</Button> : null}
        {alarm.state === 'acknowledged' && currentCohortArchived ? <Button compact tone="danger" onClick={() => dispatch({ type: 'CLEAR_QUEUE_HISTORY' })}>Clear history</Button> : null}
        {state.pod.phase === 'ready' ? <Button compact tone="danger" onClick={() => dispatch({ type: 'REQUEST_STOP_POD' })}>Stop GPU…</Button> : null}
      </div>
    </aside>
  );
  return alarm.state === 'ringing' || alarm.state === 'snoozed'
    ? createPortal(card, document.body)
    : card;
}
