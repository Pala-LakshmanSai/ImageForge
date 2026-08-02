import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { createFakeImageForgeAdapter, type ImageForgeAdapter } from './adapters/imageForgeAdapter';
import { persistSafePreferences, readPersistedBatchId } from './adapters/safePreferences';
import { BottomNav, TopBar } from './components/AppChrome';
import { DialogPortal } from './components/DialogPortal';
import { SetupAssistant } from './components/SetupAssistant';
import { Button, IconButton } from './components/primitives';
import { createInitialState, appReducer } from './domain/reducer';
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

export default function App({ initialState, adapter: injectedAdapter }: AppProps) {
  const [state, dispatch] = useReducer(appReducer, initialState, (provided) => provided ?? createInitialState());
  const adapter = useMemo(
    () => injectedAdapter ?? createFakeImageForgeAdapter(initialState?.setup.credentials),
    [injectedAdapter, initialState?.setup.credentials],
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const runtime = adapter.mode === 'production' ? adapter.runtime : undefined;
  const recoveryPointerRef = useRef<string | null>(
    adapter.mode === 'production' ? readPersistedBatchId(window.localStorage) : null,
  );
  const clearRecoveryPointerRef = useRef(false);

  useEffect(() => {
    if (!runtime) return;
    return runtime.subscribe((event) => {
      if (event.type === 'pod') dispatch({ type: 'SYNC_RUNTIME_POD', pod: event.pod });
      else if (event.type === 'batch') dispatch({ type: 'SYNC_RUNTIME_BATCH', batch: event.batch, assets: event.assets });
      else if (event.type === 'busy') dispatch({ type: 'SYNC_RUNTIME_BUSY', batch: event.batch });
      else if (event.type === 'idle') dispatch({ type: 'RUNTIME_BATCH_IDLE' });
      else if (event.type === 'create-recovery') dispatch({ type: 'SYNC_CREATE_RECOVERY', marker: event.marker });
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
    void runtime.refresh(stateRef.current).catch(() => undefined);
  }, [runtime, state.setup.completed, state.setup.credentials.runpodApiKey.configured]);

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
    if (state.batch?.canManage === true) recoveryPointerRef.current = state.batch.id;
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
  }, [adapter.mode, state.settings, state.setup.completed, state.setup.studioProfile, state.batch?.id, state.batch?.phase]);

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
    if (runtime) {
      void runtime.stopGpu(stateRef.current).catch(() => undefined);
      return;
    }
    return adapter.finishPodStop(() => dispatch({ type: 'POD_STOPPED' }));
  }, [adapter, runtime, state.pod.phase]);

  useEffect(() => {
    if (state.batch?.phase !== 'validating') return;
    if (runtime) {
      void runtime.startBatch(state.batch).catch(() => undefined);
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
    if (state.batch && ['complete', 'partial_failure', 'cancelled'].includes(state.batch.phase)) return;
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
      void runtime.refresh(current).catch(() => undefined);
      return;
    }
    dispatch(action);
  }, [runtime]);

  const screenProps = { state, dispatch: uiDispatch, adapter };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="ambient ambient--crimson" aria-hidden="true" />
      <div className="ambient ambient--cobalt" aria-hidden="true" />
      <TopBar state={state} dispatch={uiDispatch} />

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
                <h2 id="modal-title">Terminate this GPU?</h2>
                <p>
                  This sends RunPod’s Pod DELETE operation. Compute and ephemeral container data will end; the ImageForge network volume, manifests, and downloaded images remain.
                </p>
                <div className="modal__notice">
                  <strong>Confirmed target:</strong> {state.dialog.podId} · {state.pod.gpu ?? 'GPU unknown'} · {state.pod.hourlyRate === null ? 'rate unavailable' : `$${state.pod.hourlyRate.toFixed(2)}/hr`}
                </div>
                <div className="modal__notice">
                  ImageForge has no idle timer and never stops compute on completion, app exit, or connection loss.
                </div>
                <div className="modal__actions">
                  <Button data-autofocus onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Keep GPU running</Button>
                  <Button tone="danger" onClick={() => dispatch({ type: 'CONFIRM_STOP_POD' })}>Terminate compute</Button>
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
                <p>Downloaded and verified files stay in the selected folder. Pending prompts are removed from this run and the shared batch lock is released.</p>
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
