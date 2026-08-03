import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { createFakeImageForgeAdapter, type ImageForgeAdapter } from './adapters/imageForgeAdapter';
import {
  persistSafePreferences,
  readPersistedBatchRecovery,
  type PersistedBatchRecovery,
} from './adapters/safePreferences';
import { BottomNav, TopBar } from './components/AppChrome';
import { DialogPortal } from './components/DialogPortal';
import { SetupAssistant } from './components/SetupAssistant';
import { StudioCoordination } from './components/StudioCoordination';
import { Button, IconButton } from './components/primitives';
import { canStartBatch, createInitialState, appReducer } from './domain/reducer';
import type { AppAction, AppState } from './domain/types';
import { CreateScreen } from './screens/CreateScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { ProgressScreen } from './screens/ProgressScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { UsageScreen } from './screens/UsageScreen';
import './styles.css';

export interface AppProps {
  initialState?: AppState;
  adapter?: ImageForgeAdapter;
}

const CROSS_CLIENT_HEARTBEAT_MS = 4_000;

export default function App({ initialState, adapter: injectedAdapter }: AppProps) {
  const [state, dispatch] = useReducer(appReducer, initialState, (provided) => provided ?? createInitialState());
  const adapter = useMemo(
    () => injectedAdapter ?? createFakeImageForgeAdapter(initialState?.setup.credentials),
    [injectedAdapter, initialState?.setup.credentials],
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const runtime = adapter.mode === 'production' ? adapter.runtime : undefined;
  const recoveryPointerRef = useRef<PersistedBatchRecovery | null>(
    adapter.mode === 'production' ? readPersistedBatchRecovery(window.localStorage) : null,
  );
  const clearRecoveryPointerRef = useRef(false);
  const refreshInFlightRef = useRef<Promise<boolean> | null>(null);
  const observationInFlightRef = useRef<Promise<void> | null>(null);
  const batchStartInFlightRef = useRef(false);

  const refreshProductionStatus = useCallback((): Promise<boolean> => {
    if (!runtime || !stateRef.current.setup.completed || !stateRef.current.setup.credentials.runpodApiKey.configured) {
      return Promise.resolve(false);
    }
    if (refreshInFlightRef.current !== null) return refreshInFlightRef.current;
    const operation = runtime.refresh(stateRef.current)
      .then(() => true, () => false)
      .finally(() => {
        if (refreshInFlightRef.current === operation) refreshInFlightRef.current = null;
      });
    refreshInFlightRef.current = operation;
    return operation;
  }, [runtime]);

  const observeProductionStatus = useCallback((): Promise<void> => {
    if (!runtime || !stateRef.current.setup.completed || !stateRef.current.setup.credentials.runpodApiKey.configured) {
      return Promise.resolve();
    }
    if (observationInFlightRef.current !== null) return observationInFlightRef.current;
    // A strict startup/manual/pre-submit refresh is already at least as
    // authoritative as the advisory heartbeat, so do not queue duplicate work.
    if (refreshInFlightRef.current !== null) return refreshInFlightRef.current.then(() => undefined);
    const operation = runtime.observe(stateRef.current).finally(() => {
      if (observationInFlightRef.current === operation) observationInFlightRef.current = null;
    });
    observationInFlightRef.current = operation;
    return operation;
  }, [runtime]);

  useEffect(() => {
    if (!runtime || !state.setup.completed) return;
    void runtime.restoreLocalLibrary(stateRef.current).catch(() => undefined);
  }, [runtime, state.setup.completed, state.settings.defaultDestination]);

  useEffect(() => {
    if (!runtime) return;
    return runtime.subscribe((event) => {
      if (event.type === 'pod') dispatch({ type: 'SYNC_RUNTIME_POD', pod: event.pod });
      else if (event.type === 'batch') dispatch({ type: 'SYNC_RUNTIME_BATCH', batch: event.batch, assets: event.assets });
      else if (event.type === 'library') dispatch({ type: 'SYNC_RUNTIME_LIBRARY', assets: event.assets });
      else if (event.type === 'busy') dispatch({ type: 'SYNC_RUNTIME_BUSY', batch: event.batch });
      else if (event.type === 'idle') dispatch({ type: 'RUNTIME_BATCH_IDLE' });
      else if (event.type === 'stop-guard-active') dispatch({
        type: 'RUNTIME_STOP_GUARD_ACTIVE',
        podId: event.podId,
        message: event.message,
      });
      else if (event.type === 'create-recovery') dispatch({ type: 'SYNC_CREATE_RECOVERY', marker: event.marker });
      else if (event.type === 'studio') dispatch({ type: 'SYNC_STUDIO_STATE', studio: event.studio });
      else if (event.type === 'stop-blocked') dispatch({
        type: 'STUDIO_STOP_BLOCKED',
        owner: event.owner,
        completed: event.completed,
        total: event.total,
        message: event.message,
      });
      else if (event.type === 'stop-failed') dispatch({
        type: 'STUDIO_STOP_FAILED',
        message: event.message,
        retryable: event.retryable,
      });
      else if (event.type === 'stop-complete') dispatch({ type: 'STUDIO_STOPPED', alreadyStopped: event.alreadyStopped });
      else if (event.type === 'local-error') dispatch({
        type: 'RUNTIME_LOCAL_ERROR',
        batchId: event.batchId,
        code: event.code,
        message: event.message,
        retryable: event.retryable,
      });
      else if (event.type === 'notice') dispatch({ type: 'SHOW_TOAST', tone: event.tone, title: event.title, message: event.message });
      else dispatch({ type: 'RUNTIME_ERROR', scope: event.scope, code: event.code, message: event.message, retryable: event.retryable });
    });
  }, [runtime]);

  useEffect(() => {
    if (!runtime) return;
    const dispose = () => runtime.dispose();
    window.addEventListener('beforeunload', dispose);
    return () => window.removeEventListener('beforeunload', dispose);
  }, [runtime]);

  useEffect(() => {
    // Safe preferences deliberately do not persist credential metadata. Wait
    // for the native vault to confirm the RunPod key before network refresh;
    // otherwise an upgraded ad-hoc build can spend the full timeout probing
    // with a temporarily inaccessible keychain item. Worker-token metadata is
    // not a gate because Pod discovery must still expose billed compute and
    // its explicit Stop control when that separate credential needs repair.
    if (!runtime || !state.setup.completed || !state.setup.credentials.runpodApiKey.configured) return;
    let active = true;
    const sync = async () => {
      if (!active) return;
      // The first strict refresh and every later observation bind/verify the
      // current worker session before a heartbeat can use it.
      try {
        await observeProductionStatus();
      } catch {
        return;
      }
      if (!active) return;
      await runtime.heartbeat(
        stateRef.current,
        document.visibilityState === 'visible' ? 'foreground' : 'background',
      ).catch(() => undefined);
    };
    // Establish the first authoritative state immediately. Subsequent checks
    // are deliberately slower, receipt-free observations.
    void refreshProductionStatus().then((refreshed) => {
      if (!active || !refreshed) return;
      return runtime.heartbeat(
        stateRef.current,
        document.visibilityState === 'visible' ? 'foreground' : 'background',
      ).catch(() => undefined);
    });
    // RunPod lifecycle polling is read-only. Keep every open macOS and
    // Windows client aligned when another editor starts or explicitly stops
    // the shared disposable Pod, even while no batch is running.
    const triggerSync = () => { void sync(); };
    const timer = window.setInterval(triggerSync, CROSS_CLIENT_HEARTBEAT_MS);
    window.addEventListener('focus', triggerSync);
    window.addEventListener('online', triggerSync);
    document.addEventListener('visibilitychange', triggerSync);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', triggerSync);
      window.removeEventListener('online', triggerSync);
      document.removeEventListener('visibilitychange', triggerSync);
    };
  }, [observeProductionStatus, refreshProductionStatus, runtime, state.setup.completed, state.setup.credentials.runpodApiKey.configured]);

  useEffect(() => {
    let active = true;
    void adapter.credentialMetadata().then(
      (credentials) => {
        if (active) dispatch({ type: 'SET_CREDENTIAL_METADATA', credentials });
      },
      () => {
        if (active) dispatch({ type: 'SHOW_TOAST', tone: 'error', title: 'Credential vault unavailable', message: 'ImageForge could not read redacted credential metadata.' });
      },
    );
    return () => { active = false; };
  }, [adapter]);

  useEffect(() => {
    if (adapter.mode !== 'production' || !state.setup.completed) return;
    let active = true;
    void adapter.validateDestination(state.settings.defaultDestination).then(
      (validated) => {
        if (active) dispatch({ type: 'SET_DESTINATION_VALIDATED', validated });
      },
      () => {
        if (active) dispatch({ type: 'SET_DESTINATION_VALIDATED', validated: false });
      },
    );
    return () => { active = false; };
  }, [adapter, state.settings.defaultDestination, state.setup.completed]);

  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme;
    document.documentElement.dataset.density = state.settings.density;
  }, [state.settings.density, state.settings.theme]);

  useEffect(() => {
    if (adapter.mode !== 'production' || !state.setup.completed) return;
    if (state.batch?.canManage === true) {
      recoveryPointerRef.current = { id: state.batch.id, name: state.batch.name };
    }
    const recoveryOverride = clearRecoveryPointerRef.current
      ? null
      : state.batch?.canManage !== true
        ? recoveryPointerRef.current
        : undefined;
    try {
      persistSafePreferences(state, window.localStorage, recoveryOverride);
      if (clearRecoveryPointerRef.current) {
        clearRecoveryPointerRef.current = false;
        recoveryPointerRef.current = null;
      }
    } catch {
      // A storage failure must never affect GPU or batch control.
    }
  }, [adapter.mode, state.settings, state.setup.completed, state.setup.studioProfile, state.batch?.id, state.batch?.name, state.batch?.phase]);

  useEffect(() => {
    if (state.pod.lifecycleSequence === 0 || state.pod.phase !== 'selecting') return;
    if (runtime) {
      void runtime.startGpu(stateRef.current).catch(() => undefined);
      return;
    }
    return adapter.runPodLifecycle(
      {
        preference: state.settings.gpuPreference,
        allowSlowEmergency: state.settings.slowEmergencyGpuEnabled,
      },
      (update) => dispatch({ type: 'SET_POD_PHASE', ...update }),
    );
    // A lifecycle is tied to the explicit start sequence, not each intermediate phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, runtime, state.pod.lifecycleSequence]);

  useEffect(() => {
    if (state.pod.phase !== 'stopping') return;
    if (runtime) return;
    return adapter.finishPodStop(() => dispatch({ type: 'POD_STOPPED' }));
  }, [adapter, runtime, state.pod.phase]);

  useEffect(() => {
    if (state.batch?.phase !== 'validating') return;
    if (runtime) {
      void runtime.startBatch(stateRef.current).catch(() => undefined);
      return;
    }
    return adapter.validateBatch(() => dispatch({ type: 'BATCH_VALIDATED' }));
  }, [adapter, runtime, state.batch?.phase]);

  useEffect(() => {
    if (runtime) return;
    if (state.batch?.phase !== 'running') return;
    return adapter.runBatchClock(state.settings.simulationSpeed, () => dispatch({ type: 'BATCH_TICK' }));
  }, [adapter, runtime, state.batch?.phase, state.settings.simulationSpeed]);

  useEffect(() => {
    if (!runtime || !['ready', 'reconnecting'].includes(state.pod.phase)) return;
    if (state.batch?.phase === 'validating') return;
    const poll = () => void runtime.pollBatch(stateRef.current).catch(() => undefined);
    poll();
    const timer = window.setInterval(poll, 1_500);
    return () => window.clearInterval(timer);
  }, [runtime, state.pod.phase, state.batch?.phase]);

  useEffect(() => {
    if (!state.toast) return;
    const timer = window.setTimeout(() => dispatch({ type: 'DISMISS_TOAST' }), 5_200);
    return () => window.clearTimeout(timer);
  }, [state.toast]);

  const uiDispatch = useCallback((action: AppAction) => {
    if (!runtime) {
      dispatch(action);
      return;
    }
    const current = stateRef.current;
    if (action.type === 'NEW_BATCH') {
      const terminalOrEmpty = current.batch === null || ['complete', 'partial_failure', 'cancelled', 'error'].includes(current.batch.phase);
      if (terminalOrEmpty) {
        clearRecoveryPointerRef.current = true;
        runtime.beginNewBatch();
      }
    }
    if (action.type === 'TOGGLE_BATCH_PAUSE') {
      const control = current.batch?.phase === 'running' ? 'pause' : 'resume';
      void runtime.controlBatch(control, current).catch(() => undefined);
      return;
    }
    if (action.type === 'RETRY_FAILED') {
      void runtime.controlBatch('retry_failed', current).catch(() => undefined);
      return;
    }
    if (action.type === 'RESUME_INTERRUPTED_BATCH') {
      void runtime.controlBatch('resume', current).catch(() => undefined);
      return;
    }
    if (action.type === 'CONFIRM_CANCEL_BATCH') {
      dispatch({ type: 'DISMISS_DIALOG' });
      void runtime.controlBatch('cancel', current).catch(() => undefined);
      return;
    }
    if (action.type === 'CONFIRM_STOP_POD') {
      if (
        current.dialog?.type !== 'stop-pod'
        || current.dialog.podId !== current.pod.podId
        || current.pod.podId === null
      ) {
        dispatch(action);
        return;
      }
      dispatch({
        type: 'BEGIN_STUDIO_STOP',
        podId: current.pod.podId,
        gpuDisplayName: current.pod.gpu ?? 'ImageForge GPU',
      });
      void runtime.requestGpuStop(current).catch(() => undefined);
      return;
    }
    if (action.type === 'RESPOND_STUDIO_STOP') {
      void runtime.respondToGpuStop(action.requestId, action.decision).catch(() => undefined);
      return;
    }
    if (action.type === 'CANCEL_STUDIO_STOP') {
      void runtime.cancelGpuStop(action.requestId).catch(() => undefined);
      return;
    }
    if (action.type === 'START_BATCH') {
      // A remote Stop GPU can land between the last heartbeat and this click.
      // Re-read RunPod before allowing the reducer to create a validating
      // batch, so a stale ready card cannot submit to a dead worker.
      if (batchStartInFlightRef.current) return;
      batchStartInFlightRef.current = true;
      void refreshProductionStatus()
        .then(async (refreshed) => {
          if (!refreshed) {
            dispatch({
              type: 'SHOW_TOAST',
              tone: 'warning',
              title: 'GPU status unavailable',
              message: 'ImageForge could not verify the shared GPU. Generation is blocked until RunPod status is reachable.',
            });
            return;
          }
          const authoritativePod = runtime.getAuthoritativePodState?.();
          if (authoritativePod !== undefined && authoritativePod !== null) {
            dispatch({ type: 'SYNC_RUNTIME_POD', pod: authoritativePod });
          }
          // Let the authoritative Pod event settle before reducer validation.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          const latest = stateRef.current;
          const candidate = authoritativePod === undefined || authoritativePod === null
            ? latest
            : { ...latest, pod: authoritativePod };
          if (!canStartBatch(candidate)) {
            dispatch({
              type: 'SHOW_TOAST',
              tone: 'warning',
              title: 'GPU is not ready',
              message: 'The shared GPU was stopped or changed on another ImageForge client. Wait for status to synchronize before generating.',
            });
            return;
          }
          dispatch(action);
        })
        .finally(() => {
          batchStartInFlightRef.current = false;
        });
      return;
    }
    if (action.type === 'CONFIRM_RESOLVE_CREATE') {
      dispatch(action);
      void runtime.resolveAmbiguousStart().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'The interrupted RunPod create could not be resolved.';
        dispatch({ type: 'RUNTIME_ERROR', scope: 'pod', message });
      });
      return;
    }
    if (action.type === 'REFRESH_STATUS') {
      dispatch(action);
      void refreshProductionStatus();
      return;
    }
    dispatch(action);
  }, [refreshProductionStatus, runtime]);

  const screenProps = { state, dispatch: uiDispatch, adapter };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="ambient ambient--crimson" aria-hidden="true" />
      <div className="ambient ambient--cobalt" aria-hidden="true" />
      <TopBar state={state} dispatch={uiDispatch} />

      <StudioCoordination stop={state.studio.stop} dispatch={uiDispatch} />

      {state.pod.matchingPodIds.length > 1 ? (
        <aside className="duplicate-warning" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>{state.pod.matchingPodIds.length} ImageForge Pods are accruing hourly cost</strong>
            <span>{state.pod.matchingPodIds.join(' · ')}. ImageForge will never terminate either automatically.</span>
          </div>
          <Button compact tone="secondary" onClick={() => dispatch({ type: 'NAVIGATE', view: 'settings' })}>Review Pods</Button>
        </aside>
      ) : null}

      {state.pod.createRecovery ? (
        <aside className="duplicate-warning" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>Interrupted RunPod start needs reconciliation</strong>
            <span>No additional GPU can start. ImageForge is looking for {state.pod.createRecovery.podName ?? 'the exact attempted Pod'} without guessing.</span>
          </div>
          <Button compact tone="secondary" onClick={() => uiDispatch({ type: 'REQUEST_RESOLVE_CREATE' })}>Resolve start</Button>
        </aside>
      ) : null}

      {state.localSyncIssue ? (
        <aside className="local-sync-warning" role="alert" aria-live="polite">
          <AlertTriangle size={18} />
          <div>
            <strong>Local files need attention</strong>
            <span>{state.localSyncIssue.message} Shared GPU and batch status will keep updating.</span>
          </div>
          <Button compact tone="secondary" onClick={() => dispatch({ type: 'NAVIGATE', view: 'settings' })}>Open settings</Button>
        </aside>
      ) : null}

      <main id="main-content" className="page-stage" tabIndex={-1}>
        {state.activeView === 'create' ? <CreateScreen {...screenProps} /> : null}
        {state.activeView === 'progress' ? <ProgressScreen {...screenProps} /> : null}
        {state.activeView === 'library' ? <LibraryScreen {...screenProps} /> : null}
        {state.activeView === 'usage' ? <UsageScreen {...screenProps} /> : null}
        {state.activeView === 'settings' ? <SettingsScreen {...screenProps} /> : null}
      </main>

      <BottomNav state={state} dispatch={uiDispatch} />

      {state.dialog ? (
        <DialogPortal
          backdropClassName="modal-backdrop"
          surfaceClassName="modal"
          role="alertdialog"
          labelledBy="modal-title"
          onRequestClose={() => dispatch({ type: 'DISMISS_DIALOG' })}
        >
            <IconButton label="Close confirmation" icon={X} className="modal__close" onClick={() => dispatch({ type: 'DISMISS_DIALOG' })} />
            <span className="modal__symbol"><AlertTriangle size={23} /></span>
            {state.dialog.type === 'stop-pod' ? (
              <>
                <p className="eyebrow">Explicit termination</p>
                <h2 id="modal-title">Request a coordinated GPU stop?</h2>
                <p>
                  ImageForge first checks the durable batch lease and asks every other foreground editor. RunPod termination is sent only after the exact GPU is revalidated and all required editors approve.
                </p>
                <div className="modal__notice">
                  <strong>Confirmed target:</strong> {state.dialog.podId} · {state.pod.gpu ?? 'GPU unknown'} · {state.pod.hourlyRate === null ? 'rate unavailable' : `$${state.pod.hourlyRate.toFixed(2)}/hr`}
                </div>
                <div className="modal__notice">
                  Any active batch blocks this request unconditionally. A pending approval never blocks generation; starting work keeps the GPU online.
                </div>
                <div className="modal__notice">
                  ImageForge has no idle timer and never stops compute on completion, app exit, or connection loss. Network volume data and downloaded images remain.
                </div>
                <div className="modal__actions">
                  <Button data-autofocus onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Keep GPU running</Button>
                  <Button tone="danger" onClick={() => uiDispatch({ type: 'CONFIRM_STOP_POD' })}>Request coordinated stop</Button>
                </div>
              </>
            ) : state.dialog.type === 'resolve-create' ? (
              <>
                <p className="eyebrow">Interrupted GPU start</p>
                <h2 id="modal-title">Confirm that no matching Pod exists</h2>
                <p>
                  Check RunPod for <strong>{state.pod.createRecovery?.podName ?? 'the attempted ImageForge Pod'}</strong>. Continue only if that exact Pod was not created or is no longer active.
                </p>
                <div className="modal__notice">
                  ImageForge blocks every additional paid start until this marker is reconciled. It never guesses after an uncertain create response.
                </div>
                <div className="modal__actions">
                  <Button data-autofocus onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Keep blocked</Button>
                  <Button tone="danger" onClick={() => uiDispatch({ type: 'CONFIRM_RESOLVE_CREATE' })}>I confirmed no Pod exists</Button>
                </div>
              </>
            ) : state.dialog.type === 'cancel-batch' ? (
              <>
                <p className="eyebrow">Cancel batch</p>
                <h2 id="modal-title">Stop generating remaining images?</h2>
                <p>Images already saved stay in the selected folder. Unfinished prompts are removed from this run so a new batch can start.</p>
                <div className="modal__actions">
                  <Button data-autofocus onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Continue batch</Button>
                  <Button tone="danger" onClick={() => uiDispatch({ type: 'CONFIRM_CANCEL_BATCH' })}>Cancel remaining</Button>
                </div>
              </>
            ) : (
              <>
                <p className="eyebrow">Local library index</p>
                <h2 id="modal-title">Clear library history?</h2>
                <p>This clears the in-app index only. ImageForge will not delete source JPEGs from your destination folder.</p>
                <div className="modal__actions">
                  <Button data-autofocus onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Keep history</Button>
                  <Button tone="danger" onClick={() => dispatch({ type: 'CLEAR_LIBRARY' })}>Clear index</Button>
                </div>
              </>
            )}
        </DialogPortal>
      ) : null}

      {state.toast ? (
        <div className={`toast toast--${state.toast.tone}`} role="status" aria-live="polite">
          {state.toast.tone === 'success' ? <CheckCircle2 size={19} /> : state.toast.tone === 'error' ? <XCircle size={19} /> : state.toast.tone === 'warning' ? <AlertTriangle size={19} /> : <Info size={19} />}
          <div><strong>{state.toast.title}</strong><span>{state.toast.message}</span></div>
          {state.toast.action ? <Button compact tone="secondary" onClick={() => { dispatch({ type: 'NAVIGATE', view: state.toast!.action!.view }); dispatch({ type: 'DISMISS_TOAST' }); }}>{state.toast.action.label}</Button> : null}
          <IconButton label="Dismiss notification" icon={X} onClick={() => dispatch({ type: 'DISMISS_TOAST' })} />
        </div>
      ) : null}

      {!state.setup.completed ? (
        <SetupAssistant state={state} dispatch={dispatch} adapter={adapter} canClose={false} />
      ) : null}
    </div>
  );
}
