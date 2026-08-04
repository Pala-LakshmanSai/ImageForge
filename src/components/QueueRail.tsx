import { AlertTriangle, ArrowDown, ArrowUp, Bell, Check, ListPlus, Pause, Play, Trash2 } from 'lucide-react';
import { useMemo, useState, type UIEvent } from 'react';
import {
  createVirtualWindow,
  isQueuePlaceholder,
  isQueueLocallyRemovableIssue,
  queueCanStartNewRun,
} from '../domain/queue';
import { hasActivePodIdentity, type AppAction, type AppState } from '../domain/types';
import { Button, IconButton } from './primitives';
import { QueueAlarm } from './QueueAlarm';

interface QueueRailProps {
  state: AppState;
  dispatch: (action: AppAction) => void;
}

const ROW_HEIGHT = 76;
const VIEWPORT_HEIGHT = 304;

function statusLabel(state: AppState['queue']['document']['items'][number]['state']) {
  return state.replaceAll('_', ' ');
}

export function QueueRail({ state, dispatch }: QueueRailProps) {
  const { document } = state.queue;
  const [scrollTop, setScrollTop] = useState(0);
  const rows = document.items;
  const windowed = useMemo(
    () => createVirtualWindow(rows.length, scrollTop, ROW_HEIGHT, VIEWPORT_HEIGHT),
    [rows.length, scrollTop],
  );
  if (state.queue.loadState === 'error') {
    const unrecoverable = state.queue.issues.some((issue) => issue.code === 'queue_store_unrecoverable');
    return (
      <section className="queue-rail queue-rail--error" aria-labelledby="queue-heading">
        <header className="queue-rail__header">
          <div>
            <span className="eyebrow"><AlertTriangle size={13} /> Device queue needs attention</span>
            <h2 id="queue-heading">Queued work was not started</h2>
            <p>{unrecoverable ? 'No retained queue generation could be validated. Existing queue files will stay quarantined if you reset.' : 'ImageForge could not safely read the device queue.'}</p>
          </div>
          {unrecoverable ? <Button tone="danger" onClick={() => dispatch({ type: 'REQUEST_RESET_QUEUE' })}>Reset local queue…</Button> : null}
        </header>
      </section>
    );
  }
  if (rows.length === 0 && document.run === null) return null;

  const run = document.run;
  const alarm = document.alarm;
  const staged = rows.filter((row) => row.state === 'staged').length;
  const attention = rows.filter((row) => row.state === 'needs_attention' || row.state === 'interrupted').length;
  const completed = rows.filter((row) => ['completed', 'completed_with_failures', 'cancelled', 'historical'].includes(row.state)).length;
  const hasHistory = rows.some((row) => !isQueuePlaceholder(row) && row.state === 'historical');
  const currentCohortArchived = run !== null && run.cohortItemIds.length > 0 && run.cohortItemIds.every((id) => {
    const row = rows.find((candidate) => candidate.queueItemId === id);
    return row !== undefined && !isQueuePlaceholder(row) && row.state === 'historical';
  });
  const canClearHistory = hasHistory && (run === null || (run.runnerState === 'completed' && alarm?.state === 'acknowledged'));
  const nextRun = rows.filter((row) => !isQueuePlaceholder(row) && row.state === 'staged' && row.runRevision === null).length;
  const canRun = queueCanStartNewRun(document) && state.batch === null && state.pod.phase === 'ready' && hasActivePodIdentity(state.pod);
  const canPause = run?.runnerState === 'running' || run?.runnerState === 'pause_after_current';
  const canResume = run !== null && ['paused', 'needs_attention'].includes(run.runnerState);
  const notificationFallbackVisible = state.queue.notificationPermission !== 'granted'
    || alarm?.notificationDisposition === 'permission_denied'
    || alarm?.notificationDisposition === 'failed';

  function onScroll(event: UIEvent<HTMLOListElement>) {
    setScrollTop(event.currentTarget.scrollTop);
  }

  return (
    <section className="queue-rail" aria-labelledby="queue-heading">
      <header className="queue-rail__header">
        <div>
          <span className="eyebrow"><ListPlus size={13} /> Device queue</span>
          <h2 id="queue-heading">{run ? `${run.cohortItemIds.length} batches in this run` : `${staged} staged ${staged === 1 ? 'batch' : 'batches'}`}</h2>
          <p>Staged on this device — not reserved on the GPU.</p>
        </div>
        <div className="queue-rail__summary" aria-label="Queue summary">
          <span><strong>{staged}</strong> staged</span>
          <span><strong>{completed}</strong> settled</span>
          {attention > 0 ? <span className="queue-rail__attention"><strong>{attention}</strong> attention</span> : null}
          {nextRun > 0 && run ? <span><strong>{nextRun}</strong> next run</span> : null}
        </div>
        <div className="queue-rail__actions">
          {canPause ? <Button compact tone="secondary" onClick={() => dispatch({ type: 'PAUSE_QUEUE' })}><Pause size={14} /> Pause after current</Button> : null}
          {canResume ? <Button compact onClick={() => dispatch({ type: 'RESUME_QUEUE' })}><Play size={14} /> Resume queue</Button> : null}
          {!canPause && !canResume ? <Button compact disabled={!canRun} onClick={() => dispatch({ type: 'RUN_QUEUE' })}><Play size={14} /> Run queue</Button> : null}
        </div>
      </header>

      <div className="queue-rail__readiness">
        <label className="queue-rail__keep-awake">
          <input
            type="checkbox"
            checked={run !== null && run.runnerState !== 'completed' ? run.keepAwake : state.queue.keepAwakePreference}
            disabled={run !== null && run.runnerState !== 'completed'}
            onChange={(event) => dispatch({ type: 'SET_QUEUE_KEEP_AWAKE', enabled: event.target.checked })}
          />
          <span><strong>Keep this computer awake while the queue runs</strong><small>The display may sleep. Manual sleep and lid close still win.</small></span>
        </label>
        <div className="queue-rail__alarm-ready">
          <Bell size={15} />
          <span>
            <strong>{state.queue.alarmTest === 'heard' ? 'Alarm ready for the next run' : 'Test the completion alarm'}</strong>
            <small>{notificationFallbackVisible ? 'In-app fallback stays visible' : 'OS notification allowed'}</small>
          </span>
          {state.queue.alarmTest === 'tested'
            ? <Button compact tone="secondary" onClick={() => dispatch({ type: 'CONFIRM_QUEUE_ALARM' })}><Check size={13} /> I heard it — arm</Button>
            : <Button compact tone="secondary" disabled={state.queue.alarmTest === 'playing'} onClick={() => dispatch({ type: 'TEST_QUEUE_ALARM' })}>{state.queue.alarmTest === 'playing' ? 'Playing…' : 'Test sound'}</Button>}
        </div>
      </div>

      {rows.length > 0 ? (
        <ol className="queue-list" aria-label={`${rows.length} local queue batches`} onScroll={onScroll} style={{ height: Math.min(VIEWPORT_HEIGHT, rows.length * ROW_HEIGHT) }}>
          <li className="queue-list__spacer" aria-hidden="true" style={{ height: windowed.totalHeight }} />
          {rows.slice(windowed.start, windowed.end).map((row, localIndex) => {
            const absoluteIndex = windowed.start + localIndex;
            const ownsAssignedRow = !isQueuePlaceholder(row) && (
              row.runRevision === null
              || (state.queue.lease?.held === true && state.queue.lease.runRevision === row.runRevision)
            );
            const mutable = !isQueuePlaceholder(row) && row.state === 'staged' && ownsAssignedRow;
            const localRecovery = isQueueLocallyRemovableIssue(row);
            const removable = mutable || localRecovery || isQueuePlaceholder(row);
            const promptCount = isQueuePlaceholder(row) ? row.promptCount : row.prompts.length;
            const referenceCount = isQueuePlaceholder(row) ? row.referenceCount : row.references.length;
            const isNext = !isQueuePlaceholder(row) && row.runRevision === null && run !== null;
            return (
              <li
                className={`queue-row queue-row--${row.state}`}
                key={row.queueItemId}
                style={{ transform: `translateY(${(windowed.start + localIndex) * ROW_HEIGHT}px)` }}
              >
                <span className="queue-row__order">{String(absoluteIndex + 1).padStart(2, '0')}</span>
                <span className="queue-row__body">
                  <strong>{row.name}</strong>
                  <small>{promptCount} prompts · {referenceCount} {referenceCount === 1 ? 'reference' : 'references'} · {isNext ? 'Next run' : 'Local snapshot'}</small>
                </span>
                <span className={`queue-row__state queue-row__state--${row.state}`}>{statusLabel(row.state)}</span>
                {row.attentionCode ? <span className="queue-row__reason"><AlertTriangle size={12} /> {row.attentionCode.replaceAll('_', ' ')}</span> : null}
                <span className="queue-row__controls">
                  <IconButton icon={ArrowUp} label={`Move ${row.name} up`} disabled={!mutable || absoluteIndex === 0} onClick={() => dispatch({ type: 'MOVE_QUEUE_ITEM', queueItemId: row.queueItemId, direction: -1 })} />
                  <IconButton icon={ArrowDown} label={`Move ${row.name} down`} disabled={!mutable || absoluteIndex === rows.length - 1} onClick={() => dispatch({ type: 'MOVE_QUEUE_ITEM', queueItemId: row.queueItemId, direction: 1 })} />
                  <Button compact tone="quiet" disabled={!mutable || isQueuePlaceholder(row)} onClick={() => dispatch({ type: 'EDIT_QUEUE_ITEM', queueItemId: row.queueItemId })}>Edit</Button>
                  <IconButton
                    icon={Trash2}
                    label={isQueuePlaceholder(row)
                      ? `Remove corrupt item ${row.name}`
                      : localRecovery
                        ? `Remove damaged item ${row.name}`
                        : `Remove ${row.name}`}
                    disabled={!removable}
                    onClick={() => dispatch({ type: 'REMOVE_QUEUE_ITEM', queueItemId: row.queueItemId })}
                  />
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}

      <QueueAlarm state={state} dispatch={dispatch} currentCohortArchived={currentCohortArchived} />

      {canClearHistory && !currentCohortArchived ? (
        <div className="queue-history-action">
          <span>Archived queue rows are read-only.</span>
          <Button compact tone="danger" onClick={() => dispatch({ type: 'CLEAR_QUEUE_HISTORY' })}>Clear history</Button>
        </div>
      ) : null}
    </section>
  );
}
