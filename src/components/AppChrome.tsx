import {
  Activity,
  ChartNoAxesCombined,
  Images,
  MoonStar,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Square,
} from 'lucide-react';
import type { Dispatch } from 'react';
import { batchCounts } from '../domain/reducer';
import type { AppAction, AppState, PodPhase, ViewId } from '../domain/types';
import { BrandMark } from './BrandMark';
import { Button, IconButton, LinearProgress, StatusDot } from './primitives';

const NAV_ITEMS: Array<{ id: ViewId; label: string; icon: typeof Sparkles }> = [
  { id: 'create', label: 'Create', icon: Plus },
  { id: 'progress', label: 'Progress', icon: Activity },
  { id: 'library', label: 'Library', icon: Images },
  { id: 'usage', label: 'Usage', icon: ChartNoAxesCombined },
  { id: 'settings', label: 'Settings', icon: Settings },
];

function podLabel(phase: PodPhase) {
  if (phase === 'selecting') return 'checking inventory';
  return phase.replace('_', ' ');
}

function phaseTone(phase: PodPhase): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (phase === 'ready') return 'success';
  if (phase === 'error') return 'danger';
  if (phase === 'offline') return 'neutral';
  if (phase === 'reconnecting') return 'warning';
  return 'info';
}

function formatEta(state: AppState) {
  if (!state.batch) return '—';
  const counts = batchCounts(state.batch);
  if (['complete', 'partial_failure'].includes(state.batch.phase)) return 'done';
  if (state.batch.phase === 'paused') return 'paused';
  if (state.batch.phase === 'interrupted') return 'resume';
  if (state.batch.phase === 'cancelled' || state.batch.phase === 'error') return 'stopped';
  const seconds = Math.round(counts.pending * state.batch.estimatedSecondsPerImage);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function commandTitle(state: AppState): string {
  if (state.pod.createRecovery) return 'RunPod start needs confirmation';
  if (state.pod.phase === 'error') return 'GPU operation needs attention';
  return state.batch?.name ?? (state.pod.phase === 'offline' ? 'No active batch' : state.pod.statusDetail);
}

function commandProgress(state: AppState, progress: number): string {
  const needsAction = state.pod.phase === 'error' || state.pod.createRecovery !== null;
  return state.batch || !needsAction ? `${progress}%` : '—';
}

function commandEta(state: AppState): string {
  if (!state.batch && (state.pod.phase === 'error' || state.pod.createRecovery !== null)) return 'action needed';
  return formatEta(state);
}

export function TopBar({ state, dispatch }: { state: AppState; dispatch: Dispatch<AppAction> }) {
  const counts = batchCounts(state.batch);
  const podBusy = !['offline', 'ready', 'error'].includes(state.pod.phase);
  // An error is not completed work. Keep the track visibly empty so a failed
  // or ambiguous RunPod start cannot be mistaken for a successful 100% run.
  const needsAction = state.pod.phase === 'error' || state.pod.createRecovery !== null;
  const topProgress = state.batch ? counts.progress : needsAction ? 0 : state.pod.phaseProgress;

  return (
    <header className="top-bar">
      <button className="brand" type="button" onClick={() => dispatch({ type: 'NAVIGATE', view: 'create' })} aria-label="ImageForge home">
        <BrandMark size={29} />
        <span>imageforge</span>
      </button>

      <div className="command-track" aria-label="Current status">
        <div className="command-track__title">
          <span className={`command-track__phase command-track__phase--${phaseTone(state.pod.phase)}`}>
            <StatusDot tone={phaseTone(state.pod.phase)} pulse={state.pod.phase === 'ready' || podBusy} />
            {state.batch?.phase === 'running' ? 'generating' : podLabel(state.pod.phase)}
          </span>
          <strong>{commandTitle(state)}</strong>
        </div>
        <div className="command-track__numbers">
          <span>{commandProgress(state, topProgress)}</span>
          <span>eta {commandEta(state)}</span>
        </div>
        <LinearProgress value={topProgress} label="Current operation" />
      </div>

      <div className="top-instruments">
        <div className="top-instrument top-instrument--gpu">
          <span>GPU</span>
          <strong>{state.pod.gpu ?? 'offline'}</strong>
        </div>
        <div className="top-instrument top-instrument--health">
          <StatusDot tone={state.pod.health === 'healthy' ? 'success' : state.pod.health === 'degraded' ? 'danger' : 'neutral'} />
          <span>{state.pod.health}</span>
        </div>
        <IconButton
          label="Refresh worker status"
          icon={RefreshCw}
          onClick={() => dispatch({ type: 'REFRESH_STATUS', checkedAt: new Date().toISOString() })}
        />
        <IconButton
          label={`Use ${state.settings.theme === 'midnight' ? 'ink' : 'midnight'} theme`}
          icon={MoonStar}
          onClick={() =>
            dispatch({
              type: 'SET_SETTING',
              key: 'theme',
              value: state.settings.theme === 'midnight' ? 'ink' : 'midnight',
            })
          }
        />
        {state.pod.podId ? (
          <Button compact tone="danger" icon={Square} onClick={() => dispatch({ type: 'REQUEST_STOP_POD' })}>
            Stop GPU
          </Button>
        ) : (
          <Button
            compact
            tone="primary"
            icon={Sparkles}
            pending={podBusy}
            disabled={podBusy || state.pod.createRecovery !== null}
            onClick={() => dispatch({ type: 'START_POD' })}
          >
            {state.pod.phase === 'selecting' ? 'Refreshing' : podBusy ? 'Starting' : 'Start GPU'}
          </Button>
        )}
      </div>
    </header>
  );
}

export function BottomNav({ state, dispatch }: { state: AppState; dispatch: Dispatch<AppAction> }) {
  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={state.activeView === id ? 'bottom-nav__item bottom-nav__item--active' : 'bottom-nav__item'}
          onClick={() => dispatch({ type: 'NAVIGATE', view: id })}
          aria-current={state.activeView === id ? 'page' : undefined}
        >
          <span className="bottom-nav__icon"><Icon size={19} strokeWidth={1.8} /></span>
          <span>{label}</span>
          {id === 'progress' && state.batch?.phase === 'running' ? <i aria-label="Batch running" /> : null}
        </button>
      ))}
    </nav>
  );
}
