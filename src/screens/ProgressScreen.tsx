import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  CircleOff,
  Clock3,
  Download,
  FileDown,
  FolderOpen,
  Gauge,
  LoaderCircle,
  LockKeyhole,
  Pause,
  Play,
  RefreshCcw,
  RotateCw,
  ShieldCheck,
  Sparkles,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { batchCounts } from '../domain/reducer';
import type { BatchPrompt } from '../domain/types';
import { SimulatedImage } from '../components/SimulatedImage';
import { VirtualPromptList } from '../components/VirtualPromptList';
import { Button, EmptyState, Eyebrow, LinearProgress, Metric, PhaseBadge, RingProgress } from '../components/primitives';
import type { ScreenProps } from './types';

function formatDuration(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes > 0 ? `${minutes}m ${String(remainder).padStart(2, '0')}s` : `${remainder}s`;
}

function phaseTone(phase: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (phase === 'complete') return 'success';
  if (phase === 'running' || phase === 'validating') return 'info';
  if (phase === 'paused' || phase === 'partial_failure' || phase === 'reconnecting') return 'warning';
  if (phase === 'error' || phase === 'cancelled') return 'danger';
  return 'neutral';
}

function exportManifest(prompts: BatchPrompt[], batchName: string) {
  const header = 'index,prompt,seed,file,checksum,duration_seconds,status';
  const rows = prompts.map((prompt) =>
    [
      prompt.index,
      `"${prompt.text.replaceAll('"', '""')}"`,
      prompt.seed,
      prompt.filename ?? '',
      prompt.checksum ?? '',
      prompt.durationSeconds ?? '',
      prompt.status,
    ].join(','),
  );
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${batchName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-manifest.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function NoBatch({ state, dispatch }: Pick<ScreenProps, 'state' | 'dispatch'>) {
  const transitioning = !['offline', 'ready', 'error'].includes(state.pod.phase);
  if (transitioning) {
    return (
      <div className="screen progress-screen">
        <section className="page-heading"><div><Eyebrow>Progress · preparing compute</Eyebrow><h1>Warming the forge.</h1><p>{state.pod.statusDetail}</p></div></section>
        <section className="panel boot-panel">
          <div className="boot-panel__visual"><LoaderCircle className="spin" size={38} /><span>{state.pod.phaseProgress}%</span></div>
          <div className="boot-panel__copy"><PhaseBadge tone="info">{state.pod.phase}</PhaseBadge><h2>{state.pod.statusDetail}</h2><p>The model lives on the persistent network volume. Normal starts install no packages and download no weights.</p><LinearProgress value={state.pod.phaseProgress} label="GPU start progress" /></div>
          <div className="boot-steps" aria-label="GPU boot phases">
            {['Inventory', 'Provision', 'Boot', 'Load', 'Warm', 'Ready'].map((label, index) => <span key={label} className={state.pod.phaseProgress >= [4, 20, 38, 60, 82, 100][index] ? 'boot-step--complete' : ''}>{label}</span>)}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="screen progress-screen">
      <section className="page-heading"><div><Eyebrow>Progress · no active batch</Eyebrow><h1>The desk is clear.</h1><p>{state.pod.phase === 'ready' ? 'The GPU is warm and waiting for an ordered brief.' : 'Start a GPU when you are ready; ImageForge never starts compute in the background.'}</p></div></section>
      <section className="panel empty-progress-panel">
        <EmptyState
          icon={state.pod.phase === 'ready' ? Sparkles : WifiOff}
          title={state.pod.phase === 'ready' ? 'Ready for a production brief' : state.pod.phase === 'error' ? 'GPU needs attention' : 'GPU safely offline'}
          copy={state.pod.errorMessage ?? (state.pod.phase === 'ready' ? 'Paste or import up to 450 prompts, choose a destination, and begin one batch.' : 'No compute is running and no hourly GPU cost is accruing.')}
          action={
            <div className="empty-state__actions">
              {state.pod.phase !== 'ready' ? <Button tone="primary" icon={Zap} onClick={() => dispatch({ type: 'START_POD' })}>Start GPU</Button> : null}
              <Button icon={ArrowRight} onClick={() => dispatch({ type: 'NAVIGATE', view: 'create' })}>Open Create</Button>
            </div>
          }
        />
      </section>
    </div>
  );
}

export function ProgressScreen({ state, dispatch }: ScreenProps) {
  const batch = state.batch;
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const currentPrompt = useMemo(() => {
    if (!batch) return undefined;
    return (
      batch.prompts.find((prompt) => prompt.status === 'generating' || prompt.status === 'retrying') ??
      [...batch.prompts].reverse().find((prompt) => prompt.status === 'downloaded') ??
      batch.prompts[0]
    );
  }, [batch]);

  useEffect(() => {
    if (!selectedId && currentPrompt) setSelectedId(currentPrompt.id);
  }, [currentPrompt, selectedId]);

  if (!batch) return <NoBatch state={state} dispatch={dispatch} />;

  const counts = batchCounts(batch);
  const selectedPrompt = batch.prompts.find((prompt) => prompt.id === selectedId) ?? currentPrompt;
  const remainingSeconds = counts.pending * batch.estimatedSecondsPerImage;
  const isControllable = batch.owner === state.settings.userName && ['running', 'paused'].includes(batch.phase);
  const isLocked = batch.phase === 'locked';
  const isReconnecting = state.pod.phase === 'reconnecting';
  const isError = batch.phase === 'error' || state.pod.phase === 'error';
  const settled = ['complete', 'partial_failure', 'cancelled'].includes(batch.phase);

  return (
    <div className="screen progress-screen">
      <section className="page-heading progress-heading">
        <div>
          <div className="heading-status-row">
            <Eyebrow>Progress · {batch.id}</Eyebrow>
            <PhaseBadge tone={phaseTone(batch.phase)}>{batch.phase.replace('_', ' ')}</PhaseBadge>
          </div>
          <h1>{batch.name}</h1>
          <p>{batch.owner} · {batch.prompts.length} ordered frames · {state.pod.gpu ?? 'GPU disconnected'} · {batch.destination}</p>
        </div>
        <div className="page-heading__actions progress-actions">
          {isControllable ? (
            <Button icon={batch.phase === 'running' ? Pause : Play} onClick={() => dispatch({ type: 'TOGGLE_BATCH_PAUSE' })}>
              {batch.phase === 'running' ? 'Pause after frame' : 'Resume'}
            </Button>
          ) : null}
          {batch.phase === 'partial_failure' ? <Button tone="primary" icon={RotateCw} onClick={() => dispatch({ type: 'RETRY_FAILED' })}>Retry {counts.failed} failed</Button> : null}
          {settled ? <Button icon={FileDown} onClick={() => exportManifest(batch.prompts, batch.name)}>Manifest CSV</Button> : null}
          <Button icon={FolderOpen} onClick={() => dispatch({ type: 'SHOW_TOAST', tone: 'info', title: 'Destination revealed', message: batch.destination })}>Reveal folder</Button>
          {isControllable ? <Button tone="danger" icon={X} onClick={() => dispatch({ type: 'REQUEST_CANCEL_BATCH' })}>Cancel</Button> : null}
          {settled ? <Button tone="primary" icon={Sparkles} onClick={() => dispatch({ type: 'NEW_BATCH' })}>New brief</Button> : null}
        </div>
      </section>

      {isLocked ? (
        <aside className="state-banner state-banner--locked" role="status">
          <LockKeyhole size={22} />
          <div><strong>This worker is locked to {batch.owner}</strong><span>{batch.lockMessage} You can observe verified progress but cannot pause, cancel, or join.</span></div>
        </aside>
      ) : null}
      {isReconnecting ? (
        <aside className="state-banner state-banner--warning" role="status">
          <RefreshCcw className="spin-slow" size={21} />
          <div><strong>Reconnecting to worker</strong><span>Generation state comes from the durable manifest. ImageForge will request only missing downloads when the connection returns.</span></div>
          <Button compact onClick={() => dispatch({ type: 'REFRESH_STATUS', checkedAt: new Date().toISOString() })}>Check now</Button>
        </aside>
      ) : null}
      {isError ? (
        <aside className="state-banner state-banner--error" role="alert">
          <AlertTriangle size={21} />
          <div><strong>{state.pod.errorMessage ?? 'Batch stopped safely'}</strong><span>No secret values appear in this diagnostic. Existing artifacts and the durable manifest remain intact.</span></div>
          <Button compact onClick={() => dispatch({ type: 'NAVIGATE', view: 'settings' })}>Open settings</Button>
        </aside>
      ) : null}

      <section className={`panel progress-hero progress-hero--${phaseTone(batch.phase)}`}>
        <div className="progress-hero__ring">
          <RingProgress value={counts.progress} label={batch.phase === 'partial_failure' ? 'review' : batch.phase} />
        </div>
        <div className="progress-hero__body">
          <header className="progress-hero__header">
            <div>
              <Eyebrow>Verified production</Eyebrow>
              <h2>{batch.statusMessage}</h2>
            </div>
            <span className="progress-hero__receipt"><ShieldCheck size={15} /> ordered receipts live</span>
          </header>
          <div className="progress-metrics">
            <Metric label="Stage" value={`${String(counts.completed).padStart(3, '0')} / ${String(counts.total).padStart(3, '0')}`} detail={counts.failed ? `${counts.failed} slots require review` : 'Generate · verify · download'} tone={counts.failed ? 'warning' : undefined} />
            <Metric label="Status" value={batch.phase.replace('_', ' ')} detail={batch.phase === 'running' ? selectedPrompt ? `Frame ${String(selectedPrompt.index).padStart(3, '0')} · seed ${selectedPrompt.seed}` : 'Starting' : batch.statusMessage} tone={batch.phase === 'complete' ? 'success' : batch.phase === 'partial_failure' ? 'warning' : undefined} />
            <Metric label="Estimated" value={batch.phase === 'complete' ? 'Complete' : batch.phase === 'paused' ? 'On hold' : formatDuration(remainingSeconds)} detail={`${formatDuration(batch.elapsedSeconds)} elapsed · $${batch.estimatedCost.toFixed(3)} measured`} />
          </div>
          <div className="progress-hero__linear">
            <LinearProgress value={counts.progress} label={`${counts.progress}% batch progress`} />
            <div><span>{counts.completed} downloaded</span><span>{counts.pending} remaining</span><span>{counts.failed} failed</span></div>
          </div>
        </div>
      </section>

      <div className="progress-lower">
        <section className="panel pipeline-panel">
          <header className="panel-heading">
            <div><Eyebrow>Prompt pipeline</Eyebrow><h2>Ordered manifest</h2></div>
            <span className="cost-readout">Cost <strong>${batch.estimatedCost.toFixed(4)}</strong></span>
          </header>
          <div className="pipeline-legend">
            <span><i className="legend-dot legend-dot--done" /> {counts.completed} downloaded</span>
            <span><i className="legend-dot legend-dot--live" /> {batch.phase === 'running' ? '1 generating' : '0 generating'}</span>
            <span><i className="legend-dot legend-dot--wait" /> {counts.pending} waiting</span>
          </div>
          <VirtualPromptList prompts={batch.prompts} selectedId={selectedPrompt?.id} onSelect={(prompt) => setSelectedId(prompt.id)} />
        </section>

        <aside className="panel preview-panel">
          <header className="panel-heading">
            <div><Eyebrow>Live preview</Eyebrow><h2>{selectedPrompt ? `Frame ${String(selectedPrompt.index).padStart(3, '0')}` : 'Waiting for frame'}</h2></div>
            {selectedPrompt ? <PhaseBadge tone={selectedPrompt.status === 'failed' ? 'danger' : selectedPrompt.status === 'downloaded' ? 'success' : 'info'}>{selectedPrompt.status}</PhaseBadge> : null}
          </header>
          {selectedPrompt ? (
            <>
              <div className={`preview-frame preview-frame--${selectedPrompt.status}`}>
                {selectedPrompt.status === 'failed' ? (
                  <div className="preview-frame__failed"><CircleOff size={31} /><strong>Preview unavailable</strong><span>{selectedPrompt.failureReason}</span></div>
                ) : selectedPrompt.status === 'pending' ? (
                  <div className="preview-frame__waiting"><Clock3 size={29} /><strong>Ordered slot waiting</strong><span>Generation begins after earlier prompts settle.</span></div>
                ) : (
                  <SimulatedImage seed={selectedPrompt.seed} prompt={selectedPrompt.text} />
                )}
                {selectedPrompt.status === 'generating' ? <span className="preview-frame__live"><LoaderCircle className="spin" size={13} /> Rendering 4 diffusion steps</span> : null}
              </div>
              <blockquote className="preview-prompt">“{selectedPrompt.text}”</blockquote>
              <dl className="preview-details">
                <div><dt>Seed</dt><dd>{selectedPrompt.seed}</dd></div>
                <div><dt>Frame</dt><dd>1280 × 720</dd></div>
                <div><dt>Time</dt><dd>{selectedPrompt.durationSeconds ? `${selectedPrompt.durationSeconds.toFixed(1)} s` : 'measuring'}</dd></div>
                <div><dt>Receipt</dt><dd>{selectedPrompt.checksum ?? 'pending'}</dd></div>
              </dl>
              {selectedPrompt.status === 'downloaded' ? (
                <div className="download-receipt"><Check size={16} /><span><strong>{selectedPrompt.filename}</strong><small>SHA-256 verified · atomic rename complete</small></span><Download size={17} /></div>
              ) : null}
            </>
          ) : (
            <EmptyState icon={Gauge} title="Preview standing by" copy="The first generated image will appear here while later prompts continue." />
          )}
        </aside>
      </div>
    </div>
  );
}
