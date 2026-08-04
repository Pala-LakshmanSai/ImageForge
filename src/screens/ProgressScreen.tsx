import {
  AlertTriangle,
  ArrowRight,
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { batchCounts } from '../domain/reducer';
import { podPowerAction, type BatchPrompt, type BatchState } from '../domain/types';
import { aspectRatioOption } from '../domain/aspectRatio';
import { ACTIVE_PROMPT_VISIBLE_ROW_LIMIT, isQueuePlaceholder } from '../domain/queue';
import { SimulatedImage } from '../components/SimulatedImage';
import { PreviewImage } from '../components/PreviewImage';
import { Button, EmptyState, Eyebrow, LinearProgress, Metric, PhaseBadge, RingProgress } from '../components/primitives';
import type { ScreenProps } from './types';

const PROMPT_ROW_HEIGHT = 68;

function formatDuration(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes > 0 ? `${minutes}m ${String(remainder).padStart(2, '0')}s` : `${remainder}s`;
}

function phaseTone(phase: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (phase === 'complete') return 'success';
  if (phase === 'running' || phase === 'validating') return 'info';
  if (phase === 'paused' || phase === 'partial_failure' || phase === 'reconnecting' || phase === 'interrupted') return 'warning';
  if (phase === 'error' || phase === 'cancelled') return 'danger';
  return 'neutral';
}

function batchStatus(
  phase: string,
  completed: number,
  total: number,
  failed: number,
  selected?: BatchPrompt,
  remoteState?: BatchState['remoteState'],
) {
  if (phase === 'complete') return `All ${total} images saved`;
  if (phase === 'partial_failure') return `${completed} images saved · ${failed} need attention`;
  if (phase === 'paused') return `Paused after ${completed} images`;
  if (phase === 'locked') {
    if (remoteState === 'paused') return 'Another user paused this batch';
    if (remoteState === 'interrupted') return 'Another user can resume this interrupted batch';
    return 'Another user is running this batch';
  }
  if (phase === 'reconnecting') return 'Reconnecting to the GPU';
  if (phase === 'interrupted') return 'Generation was interrupted';
  if (phase === 'cancelled') return 'Batch cancelled';
  if (phase === 'error') return 'Batch needs attention';
  if (phase === 'validating') return 'Checking prompts and output folder';
  if (phase === 'running' && selected) {
    if (selected.status === 'ready' || selected.status === 'downloading') {
      return `Saving image ${selected.index} of ${total}`;
    }
    if (selected.status === 'downloaded') return `Saving completed images · ${completed} verified locally`;
    return `Creating image ${selected.index} of ${total}`;
  }
  if (phase === 'running') return 'Starting generation';
  return 'Preparing batch';
}

function promptStatusLabel(prompt: BatchPrompt) {
  if (prompt.status === 'downloaded') return 'Saved';
  if (prompt.status === 'generating') return 'Generating';
  if (prompt.status === 'retrying') return 'Retrying';
  if (prompt.status === 'ready') return 'Ready';
  if (prompt.status === 'downloading') return 'Saving';
  if (prompt.status === 'failed') return 'Needs retry';
  if (prompt.status === 'cancelled') return 'Cancelled';
  return 'Waiting';
}

function PromptStatusIcon({ prompt }: { prompt: BatchPrompt }) {
  if (prompt.status === 'downloaded') return <Check size={15} aria-hidden="true" />;
  if (prompt.status === 'generating') return <LoaderCircle className="spin" size={15} aria-hidden="true" />;
  if (prompt.status === 'retrying') return <RotateCw className="spin" size={15} aria-hidden="true" />;
  if (prompt.status === 'downloading' || prompt.status === 'ready') return <Download size={15} aria-hidden="true" />;
  if (prompt.status === 'failed' || prompt.status === 'cancelled') return <AlertTriangle size={15} aria-hidden="true" />;
  return <span className="prompt-row__pending-dot" aria-hidden="true" />;
}

function PromptQueue({
  prompts,
  selectedId,
  onSelect,
}: {
  prompts: BatchPrompt[];
  selectedId?: string;
  onSelect: (prompt: BatchPrompt) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(430);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setViewportHeight(element.clientHeight || 430);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const range = useMemo(() => {
    const overscan = 4;
    const start = Math.max(0, Math.floor(scrollTop / PROMPT_ROW_HEIGHT) - overscan);
    const visible = Math.ceil(viewportHeight / PROMPT_ROW_HEIGHT) + overscan * 2;
    return { start, end: Math.min(prompts.length, start + Math.min(ACTIVE_PROMPT_VISIBLE_ROW_LIMIT, visible)) };
  }, [prompts.length, scrollTop, viewportHeight]);

  return (
    <div
      className="virtual-list"
      ref={containerRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      aria-label={`${prompts.length} prompts`}
    >
      <div className="virtual-list__spacer" style={{ height: prompts.length * PROMPT_ROW_HEIGHT }}>
        {prompts.slice(range.start, range.end).map((prompt, localIndex) => {
          const absoluteIndex = range.start + localIndex;
          return (
            <button
              type="button"
              className={`prompt-row prompt-row--${prompt.status} ${selectedId === prompt.id ? 'prompt-row--selected' : ''}`}
              style={{ transform: `translateY(${absoluteIndex * PROMPT_ROW_HEIGHT}px)` }}
              key={prompt.id}
              onClick={() => onSelect(prompt)}
              aria-current={selectedId === prompt.id || undefined}
            >
              <span className="prompt-row__rail"><PromptStatusIcon prompt={prompt} /></span>
              <span className="prompt-row__index">{String(prompt.index).padStart(3, '0')}</span>
              <span className="prompt-row__copy">
                <strong>{prompt.text}</strong>
                <small>{prompt.durationSeconds ? `${prompt.durationSeconds.toFixed(1)}s` : 'Waiting for timing'}</small>
              </span>
              <span className="prompt-row__status">{promptStatusLabel(prompt)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function manifestCsv(prompts: BatchPrompt[]) {
  const header = 'index,prompt,seed,file,checksum,duration_seconds,status,failure_reason';
  const rows = prompts.map((prompt) =>
    [
      prompt.index,
      `"${prompt.text.replaceAll('"', '""')}"`,
      prompt.seed,
      prompt.filename ?? '',
      prompt.checksum ?? '',
      prompt.durationSeconds ?? '',
      prompt.status,
      `"${(prompt.failureReason ?? '').replaceAll('"', '""')}"`,
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

async function exportManifest(
  prompts: BatchPrompt[],
  batchId: string,
  batchName: string,
  adapter: ScreenProps['adapter'],
  dispatch: ScreenProps['dispatch'],
) {
  const content = manifestCsv(prompts);
  if (adapter.mode === 'production') {
    try {
      const path = await adapter.writeManifest(batchId, content);
      dispatch({ type: 'SHOW_TOAST', tone: 'success', title: 'CSV saved', message: path });
    } catch (error) {
      dispatch({ type: 'SHOW_TOAST', tone: 'error', title: 'CSV export failed', message: error instanceof Error ? error.message : 'The batch details could not be written to the output folder.' });
    }
    return;
  }
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${batchName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-manifest.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function NoBatch({ state, dispatch }: Pick<ScreenProps, 'state' | 'dispatch'>) {
  const powerAction = podPowerAction(state.pod);
  const exactPodReady = state.pod.phase === 'ready' && powerAction === 'stop';
  const transitioning = powerAction === 'start' && !['offline', 'ready', 'error'].includes(state.pod.phase);
  if (transitioning) {
    return (
      <div className="screen progress-screen">
        <section className="page-heading"><div><Eyebrow>Progress</Eyebrow><h1>Starting GPU</h1><p>{state.pod.statusDetail}</p></div></section>
        <section className="panel boot-panel">
          <div className="boot-panel__visual"><LoaderCircle className="spin" size={38} /><span>{state.pod.phaseProgress}%</span></div>
          <div className="boot-panel__copy"><PhaseBadge tone="info">{state.pod.phase}</PhaseBadge><h2>{state.pod.statusDetail}</h2><p>ImageForge is preparing the selected GPU and model. A cold start can take a few minutes.</p><LinearProgress value={state.pod.phaseProgress} label="GPU start progress" /></div>
          <div className="boot-steps" role="group" aria-label="GPU boot phases">
            {['Inventory', 'Provision', 'Boot', 'Load', 'Warm', 'Ready'].map((label, index) => <span key={label} className={state.pod.phaseProgress >= [4, 20, 38, 60, 82, 100][index] ? 'boot-step--complete' : ''}>{label}</span>)}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="screen progress-screen">
      <section className="page-heading"><div><Eyebrow>Progress</Eyebrow><h1>No batch running</h1><p>{powerAction === 'stop' ? 'The exact GPU remains attached while its status is reviewed.' : exactPodReady ? 'The GPU is ready for a new batch.' : 'Start a GPU when you are ready. ImageForge never starts compute in the background.'}</p></div></section>
      <section className="panel empty-progress-panel">
        <EmptyState
          icon={exactPodReady ? Sparkles : WifiOff}
          title={powerAction === 'stop' ? state.pod.phase === 'error' ? 'GPU needs attention' : 'GPU status needs review' : exactPodReady ? 'Ready for a new batch' : 'GPU identity needed'}
          copy={state.pod.errorMessage ?? (powerAction === 'stop' ? 'The exact GPU Pod remains attached. Review status before generating or stopping it.' : exactPodReady ? 'Add prompts and choose an output folder in Create.' : 'The worker reported ready without an exact Pod identity. Refresh status before generating.')}
          action={
            <div className="empty-state__actions">
              {powerAction === 'start' ? <Button tone="primary" icon={Zap} pending={transitioning} disabled={transitioning || state.pod.phase === 'ready' || state.pod.createRecovery !== null} onClick={() => dispatch({ type: 'START_POD' })}>{state.pod.phase === 'ready' ? 'GPU identity needed' : 'Start GPU'}</Button> : null}
              <Button icon={ArrowRight} onClick={() => dispatch({ type: 'NAVIGATE', view: 'create' })}>Open Create</Button>
            </div>
          }
        />
      </section>
    </div>
  );
}

export function ProgressScreen({ state, dispatch, adapter }: ScreenProps) {
  const batch = state.batch;
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const manualSelectionRef = useRef(false);
  const [downloadingIndex, setDownloadingIndex] = useState<number | null>(null);

  async function downloadImage(prompt: BatchPrompt): Promise<void> {
    if (!batch || downloadingIndex !== null) return;
    if (!adapter.downloadAsset || !prompt.checksum) {
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'error',
        title: 'Download unavailable',
        message: 'This image is not ready to download yet.',
      });
      return;
    }
    setDownloadingIndex(prompt.index);
    try {
      const savedPath = await adapter.downloadAsset({
        batchId: batch.id,
        index: prompt.index,
        batchName: batch.name,
        checksum: prompt.checksum,
      });
      if (savedPath !== null) {
        dispatch({
          type: 'SHOW_TOAST',
          tone: 'success',
          title: 'Image downloaded',
          message: `${batch.name} · ${String(prompt.index).padStart(3, '0')} was saved as a new file.`,
        });
      }
    } catch (error) {
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'error',
        title: 'Download failed',
        message: error instanceof Error ? error.message : 'The image could not be downloaded.',
      });
    } finally {
      setDownloadingIndex(null);
    }
  }

  const currentPrompt = useMemo(() => {
    if (!batch) return undefined;
    return (
      batch.prompts.find((prompt) => ['generating', 'retrying', 'ready', 'downloading'].includes(prompt.status)) ??
      [...batch.prompts].reverse().find((prompt) => prompt.status === 'downloaded') ??
      batch.prompts[0]
    );
  }, [batch]);

  useEffect(() => {
    manualSelectionRef.current = false;
    setSelectedId(undefined);
  }, [batch?.id]);

  useEffect(() => {
    if (!manualSelectionRef.current && currentPrompt) setSelectedId(currentPrompt.id);
  }, [currentPrompt]);

  if (!batch) return <NoBatch state={state} dispatch={dispatch} />;

  const counts = batchCounts(batch);
  const selectedPrompt = batch.prompts.find((prompt) => prompt.id === selectedId) ?? currentPrompt;
  const remainingSeconds = counts.pending * batch.estimatedSecondsPerImage;
  const canManage = adapter.mode === 'production'
    ? batch.canManage === true
    : batch.owner === state.settings.userName;
  const hasGenerationWork = batch.prompts.some((prompt) =>
    ['pending', 'generating', 'retrying'].includes(prompt.status),
  );
  const isControllable = canManage && (
    batch.phase === 'paused' || (batch.phase === 'running' && hasGenerationWork)
  );
  const isLocked = batch.phase === 'locked';
  const isReconnecting = state.pod.phase === 'reconnecting';
  const isError = batch.phase === 'error' || state.pod.phase === 'error';
  const isInterrupted = batch.phase === 'interrupted';
  const canResolveInterrupted = isInterrupted && canManage;
  const exactPodAttached = podPowerAction(state.pod) === 'stop';
  const canResumeInterrupted = canResolveInterrupted && state.pod.phase === 'ready' && exactPodAttached;
  const settled = ['complete', 'partial_failure', 'cancelled'].includes(batch.phase);
  const displayedPhase = isLocked ? (batch.remoteState ?? batch.phase) : batch.phase;
  const status = batchStatus(
    batch.phase,
    counts.completed,
    counts.total,
    counts.failed,
    currentPrompt,
    batch.remoteState,
  );
  const remoteActivity = batch.remoteState === 'paused'
    ? 'paused this batch'
    : batch.remoteState === 'interrupted'
      ? 'has a resumable interrupted batch'
      : 'is running this batch';
  const revealTarget = batch.prompts.find(
    (prompt) => prompt.status === 'downloaded' && prompt.filename,
  )?.filename;
  const queueRun = state.queue.document.run;
  const queueIndex = batch.queueItemId && queueRun
    ? queueRun.cohortItemIds.indexOf(batch.queueItemId)
    : -1;
  const nextQueueRow = queueRun && queueIndex >= 0
    ? state.queue.document.items.find((row) => row.queueItemId === queueRun.cohortItemIds[queueIndex + 1])
    : undefined;

  return (
    <div className="screen progress-screen">
      <section className="page-heading progress-heading">
        <div>
          <div className="heading-status-row">
            <Eyebrow>Progress</Eyebrow>
            <PhaseBadge tone={phaseTone(displayedPhase)}>{displayedPhase.replace('_', ' ')}</PhaseBadge>
          </div>
          <h1>{batch.name}</h1>
          <p>{batch.owner} · {counts.total} images · {exactPodAttached ? state.pod.gpu ?? 'GPU identity unavailable' : 'GPU identity unavailable'}</p>
        </div>
        <div className="page-heading__actions progress-actions">
          {isControllable ? (
            <Button icon={batch.phase === 'running' ? Pause : Play} onClick={() => dispatch({ type: 'TOGGLE_BATCH_PAUSE' })}>
              {batch.phase === 'running' ? 'Pause after frame' : 'Resume'}
            </Button>
          ) : null}
          {batch.phase === 'partial_failure' ? <Button tone="primary" icon={RotateCw} onClick={() => dispatch({ type: 'RETRY_FAILED' })}>Retry {counts.failed} failed</Button> : null}
          {canResumeInterrupted ? <Button tone="primary" icon={Play} onClick={() => dispatch({ type: 'RESUME_INTERRUPTED_BATCH' })}>Resume interrupted batch</Button> : null}
          {canResolveInterrupted && podPowerAction(state.pod) === 'start' && ['offline', 'error'].includes(state.pod.phase) ? <Button tone="primary" icon={Zap} onClick={() => dispatch({ type: 'START_POD' })}>Restart GPU to resume</Button> : null}
          {settled || isInterrupted ? <Button icon={FileDown} onClick={() => void exportManifest(batch.prompts, batch.id, batch.name, adapter, dispatch)}>Export CSV</Button> : null}
          <Button
            icon={FolderOpen}
            onClick={() => {
              void adapter.revealPath(revealTarget)
                .then(() => dispatch({
                  type: 'SHOW_TOAST',
                  tone: 'success',
                  title: 'Folder opened',
                  message: revealTarget ? `${batch.name} saved images` : batch.destination,
                }))
                .catch((error: unknown) => dispatch({
                  type: 'SHOW_TOAST',
                  tone: 'error',
                  title: 'Could not open folder',
                  message: error instanceof Error
                    ? error.message
                    : 'The output folder could not be opened.',
                }));
            }}
          >
            Show in folder
          </Button>
          {isControllable ? <Button tone="danger" icon={X} onClick={() => dispatch({ type: 'REQUEST_CANCEL_BATCH' })}>Cancel</Button> : null}
          {canResolveInterrupted && state.pod.phase === 'ready' ? <Button tone="danger" icon={X} onClick={() => dispatch({ type: 'REQUEST_CANCEL_BATCH' })}>Cancel interrupted batch</Button> : null}
          {settled ? <Button tone="primary" icon={Sparkles} onClick={() => dispatch({ type: 'NEW_BATCH' })}>New brief</Button> : null}
        </div>
      </section>
      {queueRun && queueIndex >= 0 ? (
        <aside className="queue-progress-context" role="status">
          <span><strong>Batch {queueIndex + 1} of {queueRun.cohortItemIds.length}</strong> in this device queue</span>
          <span>{nextQueueRow && !isQueuePlaceholder(nextQueueRow) ? `Next: ${nextQueueRow.name} · ${nextQueueRow.prompts.length} prompts` : 'This is the final staged batch.'}</span>
          <Button compact tone="secondary" onClick={() => dispatch({ type: 'NAVIGATE', view: 'create' })}>View queue</Button>
        </aside>
      ) : null}

      {isLocked ? (
        <aside className="state-banner state-banner--locked" role="status">
          <LockKeyhole size={22} />
          <div><strong>{batch.owner} {remoteActivity}</strong><span>{batch.lockMessage} You can watch overall progress but cannot pause, cancel, or join.</span></div>
        </aside>
      ) : null}
      {isReconnecting ? (
        <aside className="state-banner state-banner--warning" role="status">
          <RefreshCcw className="spin-slow" size={21} />
          <div><strong>Reconnecting to the GPU</strong><span>ImageForge will resume status checks and save any missing images when the connection returns.</span></div>
          <Button compact onClick={() => dispatch({ type: 'REFRESH_STATUS', checkedAt: new Date().toISOString() })}>Check now</Button>
        </aside>
      ) : null}
      {isInterrupted ? (
        <aside className="state-banner state-banner--warning" role="status">
          <WifiOff size={21} />
          <div><strong>Generation was interrupted safely</strong><span>Images already saved remain complete. {canResolveInterrupted ? (canResumeInterrupted ? 'Resume from the first unfinished prompt or cancel the batch.' : state.pod.phase === 'ready' ? 'The exact GPU identity is unavailable. Refresh status or cancel the batch.' : 'Restart a GPU, then resume from the first unfinished prompt—or cancel the batch now.') : `${batch.owner} must resume or cancel this batch.`}</span></div>
        </aside>
      ) : null}
      {isError ? (
        <aside className="state-banner state-banner--error" role="alert">
          <AlertTriangle size={21} />
          <div><strong>{state.pod.errorMessage ?? 'Batch stopped safely'}</strong><span>No secret values appear here. Images already saved remain in the output folder.</span></div>
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
              <Eyebrow>Batch progress</Eyebrow>
              <h2>{status}</h2>
            </div>
            <span className="progress-hero__receipt"><ShieldCheck size={15} /> saving images as they finish</span>
          </header>
          <div className="progress-metrics">
            <Metric label="Images" value={`${String(counts.completed).padStart(3, '0')} / ${String(counts.total).padStart(3, '0')}`} detail={counts.failed ? `${counts.failed} need attention` : 'Generate · save'} tone={counts.failed ? 'warning' : undefined} />
            <Metric label="Status" value={batch.phase.replace('_', ' ')} detail={status} tone={batch.phase === 'complete' ? 'success' : batch.phase === 'partial_failure' ? 'warning' : undefined} />
            <Metric label="Time left" value={batch.phase === 'complete' ? 'Complete' : batch.phase === 'paused' ? 'On hold' : formatDuration(remainingSeconds)} detail={`${formatDuration(batch.elapsedSeconds)} elapsed · $${batch.estimatedCost.toFixed(3)} cost`} />
          </div>
          <div className="progress-hero__linear">
            <LinearProgress value={counts.progress} label={`${counts.progress}% batch progress`} />
            <div><span>{counts.completed} saved</span><span>{counts.pending} remaining</span><span>{counts.failed} failed</span></div>
          </div>
        </div>
      </section>

      <div className="progress-lower">
        <section className="panel pipeline-panel">
          <header className="panel-heading">
            <div><Eyebrow>Images</Eyebrow><h2>Queue</h2></div>
            <span className="cost-readout">Cost <strong>${batch.estimatedCost.toFixed(4)}</strong></span>
          </header>
          <div className="pipeline-legend">
            <span><i className="legend-dot legend-dot--done" /> {counts.completed} saved</span>
            <span><i className="legend-dot legend-dot--live" /> {batch.phase === 'running' ? `1 ${selectedPrompt?.status ?? 'active'}` : '0 active'}</span>
            <span><i className="legend-dot legend-dot--wait" /> {counts.pending} waiting</span>
          </div>
          {isLocked ? (
            <div className="locked-manifest-placeholder">
              <LockKeyhole size={29} />
              <strong>Prompt text stays private to {batch.owner}</strong>
              <span>You can see overall progress only. No images or prompts will be saved to this computer.</span>
            </div>
          ) : (
            <PromptQueue
              prompts={batch.prompts}
              selectedId={selectedPrompt?.id}
              onSelect={(prompt) => {
                manualSelectionRef.current = true;
                setSelectedId(prompt.id);
              }}
            />
          )}
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
                ) : adapter.mode === 'production' ? (
                  <PreviewImage
                    cacheKey={`${batch.id}:${selectedPrompt.index}:${selectedPrompt.checksum ?? selectedPrompt.status}`}
                    alt={`Generated preview for frame ${String(selectedPrompt.index).padStart(3, '0')}`}
                    loader={
                      adapter.fetchPreview && ['ready', 'downloaded'].includes(selectedPrompt.status)
                        ? () => adapter.fetchPreview!(batch.id, selectedPrompt.index)
                        : undefined
                    }
                    fallback={
                      <div className="preview-frame__waiting">
                        <ShieldCheck size={29} />
                        <strong>{selectedPrompt.status === 'downloaded' ? 'Loading preview' : 'Preview not ready yet'}</strong>
                        <span>{selectedPrompt.status === 'downloaded' ? 'The full image is saved in your selected folder.' : 'The preview appears when this image is ready.'}</span>
                      </div>
                    }
                  />
                ) : (
                  <SimulatedImage seed={selectedPrompt.seed} prompt={selectedPrompt.text} compact />
                )}
                {selectedPrompt.status === 'generating' || selectedPrompt.status === 'retrying' ? <span className="preview-frame__live"><LoaderCircle className="spin" size={13} /> {selectedPrompt.status === 'retrying' ? selectedPrompt.failureReason : 'Rendering 4 diffusion steps'}</span> : null}
                {selectedPrompt.status === 'ready' ? <span className="preview-frame__live"><ShieldCheck size={13} /> Preparing full image</span> : null}
                {selectedPrompt.status === 'downloading' ? <span className="preview-frame__live"><Download size={13} /> Saving to your folder</span> : null}
              </div>
              <blockquote className="preview-prompt">“{selectedPrompt.text}”</blockquote>
              <dl className="preview-details">
                <div><dt>Frame</dt><dd>{aspectRatioOption(state.batch?.aspectRatio ?? '16:9').label} · {aspectRatioOption(state.batch?.aspectRatio ?? '16:9').width} × {aspectRatioOption(state.batch?.aspectRatio ?? '16:9').height}</dd></div>
                <div><dt>Time</dt><dd>{selectedPrompt.durationSeconds ? `${selectedPrompt.durationSeconds.toFixed(1)} s` : 'measuring'}</dd></div>
              </dl>
              {selectedPrompt.status === 'downloaded' ? (
                <div className="download-receipt">
                  <Check size={16} aria-hidden="true" />
                  <span>
                    <strong>Image saved</strong>
                    <small>Frame {String(selectedPrompt.index).padStart(3, '0')} is in {batch.name}</small>
                  </span>
                  <Button
                    compact
                    tone="quiet"
                    icon={Download}
                    pending={downloadingIndex === selectedPrompt.index}
                    disabled={downloadingIndex !== null}
                    onClick={() => void downloadImage(selectedPrompt)}
                  >
                    Download
                  </Button>
                </div>
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
