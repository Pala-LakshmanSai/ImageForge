import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect, useMemo, useReducer } from 'react';
import { createFakeImageForgeAdapter, type ImageForgeAdapter } from './adapters/imageForgeAdapter';
import { BottomNav, TopBar } from './components/AppChrome';
import { Button, IconButton } from './components/primitives';
import { createDemoState, appReducer } from './domain/reducer';
import type { AppState } from './domain/types';
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
  const [state, dispatch] = useReducer(appReducer, initialState ?? createDemoState());
  const adapter = useMemo(() => injectedAdapter ?? createFakeImageForgeAdapter(), [injectedAdapter]);

  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme;
    document.documentElement.dataset.density = state.settings.density;
  }, [state.settings.density, state.settings.theme]);

  useEffect(() => {
    if (state.pod.phase !== 'selecting') return;
    return adapter.runPodLifecycle((update) => dispatch({ type: 'SET_POD_PHASE', ...update }));
  }, [adapter, state.pod.phase]);

  useEffect(() => {
    if (state.pod.phase !== 'stopping') return;
    return adapter.finishPodStop(() => dispatch({ type: 'POD_STOPPED' }));
  }, [adapter, state.pod.phase]);

  useEffect(() => {
    if (state.batch?.phase !== 'validating') return;
    return adapter.validateBatch(() => dispatch({ type: 'BATCH_VALIDATED' }));
  }, [adapter, state.batch?.phase]);

  useEffect(() => {
    if (state.batch?.phase !== 'running') return;
    return adapter.runBatchClock(state.settings.simulationSpeed, () => dispatch({ type: 'BATCH_TICK' }));
  }, [adapter, state.batch?.phase, state.settings.simulationSpeed]);

  useEffect(() => {
    if (!state.toast) return;
    const timer = window.setTimeout(() => dispatch({ type: 'DISMISS_TOAST' }), 5_200);
    return () => window.clearTimeout(timer);
  }, [state.toast]);

  const screenProps = { state, dispatch, adapter };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="ambient ambient--crimson" aria-hidden="true" />
      <div className="ambient ambient--cobalt" aria-hidden="true" />
      <TopBar state={state} dispatch={dispatch} />

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

      <main id="main-content" className="page-stage" tabIndex={-1}>
        {state.activeView === 'create' ? <CreateScreen {...screenProps} /> : null}
        {state.activeView === 'progress' ? <ProgressScreen {...screenProps} /> : null}
        {state.activeView === 'library' ? <LibraryScreen {...screenProps} /> : null}
        {state.activeView === 'usage' ? <UsageScreen {...screenProps} /> : null}
        {state.activeView === 'settings' ? <SettingsScreen {...screenProps} /> : null}
      </main>

      <BottomNav state={state} dispatch={dispatch} />

      {state.dialog ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => dispatch({ type: 'DISMISS_DIALOG' })}>
          <section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(event) => event.stopPropagation()}>
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
                  ImageForge has no idle timer and never stops compute on completion, app exit, or connection loss.
                </div>
                <div className="modal__actions">
                  <Button onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Keep GPU running</Button>
                  <Button tone="danger" onClick={() => dispatch({ type: 'CONFIRM_STOP_POD' })}>Terminate compute</Button>
                </div>
              </>
            ) : state.dialog.type === 'cancel-batch' ? (
              <>
                <p className="eyebrow">Cancel batch</p>
                <h2 id="modal-title">Stop generating remaining images?</h2>
                <p>Downloaded and verified files stay in the selected folder. Pending prompts are removed from this run and the shared batch lock is released.</p>
                <div className="modal__actions">
                  <Button onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Continue batch</Button>
                  <Button tone="danger" onClick={() => dispatch({ type: 'CONFIRM_CANCEL_BATCH' })}>Cancel remaining</Button>
                </div>
              </>
            ) : (
              <>
                <p className="eyebrow">Local library index</p>
                <h2 id="modal-title">Clear library history?</h2>
                <p>This clears the in-app index only. ImageForge will not delete source JPEGs from your destination folder.</p>
                <div className="modal__actions">
                  <Button onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Keep history</Button>
                  <Button tone="danger" onClick={() => dispatch({ type: 'CLEAR_LIBRARY' })}>Clear index</Button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}

      {state.toast ? (
        <div className={`toast toast--${state.toast.tone}`} role="status" aria-live="polite">
          {state.toast.tone === 'success' ? <CheckCircle2 size={19} /> : state.toast.tone === 'error' ? <XCircle size={19} /> : state.toast.tone === 'warning' ? <AlertTriangle size={19} /> : <Info size={19} />}
          <div><strong>{state.toast.title}</strong><span>{state.toast.message}</span></div>
          <IconButton label="Dismiss notification" icon={X} onClick={() => dispatch({ type: 'DISMISS_TOAST' })} />
        </div>
      ) : null}
    </div>
  );
}
