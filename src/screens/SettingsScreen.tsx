import {
  AlertTriangle,
  Check,
  ChevronRight,
  Database,
  EyeOff,
  Folder,
  Gauge,
  KeyRound,
  Laptop,
  LockKeyhole,
  MonitorCog,
  RotateCcw,
  Save,
  Server,
  ShieldCheck,
  Sparkles,
  UserRound,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import type { CredentialKind, OperationalScenario } from '../domain/types';
import { aspectRatioOption } from '../domain/aspectRatio';
import { Button, Eyebrow, PhaseBadge } from '../components/primitives';
import { SetupAssistant } from '../components/SetupAssistant';
import type { ScreenProps } from './types';

const SCENARIOS: Array<{ id: OperationalScenario; label: string; note: string }> = [
  { id: 'offline', label: 'Offline', note: 'No compute or batch' },
  { id: 'provisioning', label: 'Provisioning', note: 'Creating one approved GPU' },
  { id: 'loading', label: 'Loading', note: 'Model loading from volume' },
  { id: 'warming', label: 'Warming', note: 'Inference graph warmup' },
  { id: 'ready', label: 'Ready', note: 'Warm, no active batch' },
  { id: 'running', label: 'Running', note: 'Ordered downloads in flight' },
  { id: 'paused', label: 'Paused', note: 'Owner retains batch lock' },
  { id: 'locked', label: 'Locked', note: 'Other user owns batch' },
  { id: 'duplicate_pods', label: 'Duplicate Pods', note: 'Manual cost warning' },
  { id: 'reconnecting', label: 'Reconnecting', note: 'Durable resume path' },
  { id: 'partial_failure', label: 'Partial failure', note: 'Retry failed slots only' },
  { id: 'complete', label: 'Complete', note: 'All receipts verified' },
  { id: 'error', label: 'Error', note: 'Safe, redacted diagnostic' },
];

function SettingSectionTitle({ icon: Icon, eyebrow, title }: { icon: typeof UserRound; eyebrow: string; title: string }) {
  return (
    <header className="settings-section-title">
      <span><Icon size={19} /></span>
      <div><Eyebrow>{eyebrow}</Eyebrow><h2>{title}</h2></div>
    </header>
  );
}

export function SettingsScreen({ state, dispatch, adapter }: ScreenProps) {
  const productionLocked = adapter.mode === 'production' && (
    state.pod.podId !== null ||
    (state.batch !== null && !['complete', 'partial_failure', 'cancelled', 'error'].includes(state.batch.phase))
  );
  const activeBatch = state.batch !== null && !['complete', 'partial_failure', 'cancelled', 'error'].includes(state.batch.phase);
  const [choosingDestination, setChoosingDestination] = useState(false);
  const [scenario, setScenario] = useState<OperationalScenario>('running');
  const [showSetup, setShowSetup] = useState(false);
  const [setupInitialStep, setSetupInitialStep] = useState(0);
  const [credentialOnlyKind, setCredentialOnlyKind] = useState<CredentialKind | undefined>();

  async function chooseDefaultDestination() {
    if (productionLocked) return;
    setChoosingDestination(true);
    try {
      const path = await adapter.chooseDestination(state.settings.defaultDestination);
      if (path === null) return;
      const validated = await adapter.validateDestination(path);
      dispatch({ type: 'SET_SETTING', key: 'defaultDestination', value: path });
      dispatch({ type: 'SET_DESTINATION_VALIDATED', validated });
    } finally {
      setChoosingDestination(false);
    }
  }

  function openSetup(step = 0, kind?: CredentialKind) {
    setSetupInitialStep(step);
    setCredentialOnlyKind(kind);
    setShowSetup(true);
  }

  async function testConnection() {
    const result = await adapter.testConnection({
      profile: state.setup.studioProfile,
      destination: state.settings.defaultDestination,
      destinationValidated: state.setup.destinationValidated,
      credentials: state.setup.credentials,
    });
    dispatch({
      type: 'SHOW_TOAST',
      tone: result.ok ? 'success' : 'error',
      title: result.ok ? 'Connection metadata passed' : 'Connection needs attention',
      message: result.message,
    });
  }

  return (
    <div className="screen settings-screen">
      <section className="page-heading">
        <div><Eyebrow>Settings · this device</Eyebrow><h1>Make the desk yours.</h1><p>Identity, local delivery, redacted connection health, and explicit GPU control.</p></div>
        <div className="page-heading__actions">
          <Button icon={Laptop} disabled={productionLocked} onClick={() => openSetup()}>Review setup</Button>
          <PhaseBadge tone="success"><ShieldCheck size={13} /> secrets redacted</PhaseBadge>
          <Button tone="primary" icon={Save} onClick={() => dispatch({ type: 'SAVE_SETTINGS' })}>Save preferences</Button>
        </div>
      </section>

      <div className="settings-layout">
        <div className="settings-column">
          <section className="panel settings-panel">
            <SettingSectionTitle icon={UserRound} eyebrow="Identity & delivery" title="Local production profile" />
            <div className="settings-form-grid">
              <label className="settings-field"><span>Display name</span><small>Visible when you hold the shared batch lock.</small><input value={state.settings.userName} maxLength={40} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'userName', value: event.target.value })} /></label>
              <label className="settings-field"><span>Default destination</span><small>Full images and receipts stay on this device.</small><button type="button" className="settings-picker" disabled={productionLocked || choosingDestination} onClick={() => void chooseDefaultDestination()}><Folder size={16} /><strong>{choosingDestination ? 'Opening chooser…' : state.settings.defaultDestination}</strong><ChevronRight size={15} /></button></label>
            </div>
          </section>

          <section className="panel settings-panel">
            <SettingSectionTitle icon={KeyRound} eyebrow="Secure connection" title="Credential health" />
            <p className="settings-intro">React never receives a saved credential. These cards contain redacted metadata returned by the desktop vault abstraction.</p>
            <div className="credential-list">
              <article className="credential-card">
                <span className="credential-card__icon"><KeyRound size={18} /></span>
                <div><strong>RunPod restricted API key</strong><small>{state.setup.credentials.runpodApiKey.configured ? `Configured · suffix •••• ${state.setup.credentials.runpodApiKey.suffix} · ${state.setup.credentials.runpodApiKey.provider}` : `Not configured · ${state.setup.credentials.runpodApiKey.provider}`}</small></div>
                <PhaseBadge tone={state.setup.credentials.runpodApiKey.configured ? 'success' : 'warning'}>{state.setup.credentials.runpodApiKey.configured ? 'configured' : 'required'}</PhaseBadge>
                <Button compact disabled={activeBatch} onClick={() => openSetup(1, 'runpodApiKey')}>Replace</Button>
              </article>
              <article className="credential-card">
                <span className="credential-card__icon"><LockKeyhole size={18} /></span>
                <div><strong>Per-user worker credential</strong><small>{state.setup.credentials.workerToken.configured ? `Configured · suffix •••• ${state.setup.credentials.workerToken.suffix} · never placed in a URL` : `Not configured · ${state.setup.credentials.workerToken.provider}`}</small></div>
                <PhaseBadge tone={state.setup.credentials.workerToken.configured ? 'success' : 'warning'}>{state.setup.credentials.workerToken.configured ? 'configured' : 'required'}</PhaseBadge>
                <Button compact disabled={activeBatch} onClick={() => openSetup(2, 'workerToken')}>Replace</Button>
              </article>
            </div>
            <div className="redaction-note"><EyeOff size={17} /><span><strong>Screenshot-safe by design</strong><small>Secrets are excluded from UI state, logs, analytics, crash reports, and project files.</small></span></div>
          </section>

          <section className="panel settings-panel">
            <SettingSectionTitle icon={MonitorCog} eyebrow="Interface" title="Display & feedback" />
            <div className="setting-rows">
              <label className="select-row"><span><strong>Theme</strong><small>Both modes preserve the dark production-console contrast.</small></span><select value={state.settings.theme} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'theme', value: event.target.value as 'midnight' | 'ink' })}><option value="midnight">Midnight cobalt</option><option value="ink">Deep ink</option></select></label>
              <label className="select-row"><span><strong>Information density</strong><small>Compact keeps long prompt-list reviews efficient.</small></span><select value={state.settings.density} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'density', value: event.target.value as 'comfortable' | 'compact' })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
            </div>
          </section>
        </div>

        <div className="settings-column">
          <section className="panel settings-panel">
            <SettingSectionTitle icon={Server} eyebrow="RunPod attachment" title="One GPU, discovered live" />
            <div className="pod-attachment-card">
              <div className="pod-attachment-card__top"><span><Zap size={20} /></span><div><strong>{state.pod.gpu ?? 'No active compute'}</strong><small>{state.pod.podId ? `${state.pod.podId} · disposable session ID` : 'A fresh Pod ID is discovered after each explicit start.'}</small></div><PhaseBadge tone={state.pod.phase === 'ready' ? 'success' : state.pod.phase === 'error' ? 'danger' : 'neutral'}>{state.pod.phase}</PhaseBadge></div>
              <dl><div><dt>Fallback pool</dt><dd>7 ordinary EU-RO-1 GPUs</dd></div><div><dt>Selection</dt><dd>Atomic ordered fallback</dd></div><div><dt>Template</dt><dd>q8sfgixfy2 · pinned worker</dd></div><div><dt>Port</dt><dd>8000 / HTTPS proxy</dd></div></dl>
            </div>
            <div className="setting-rows pod-preferences">
              <label className="select-row"><span><strong>GPU preference</strong><small>Ranks the compatible pool; it never pins one GPU model.</small></span><select value={state.settings.gpuPreference} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'gpuPreference', value: event.target.value as 'best_value' | 'fastest' })}><option value="best_value">Best whole-batch value</option><option value="fastest">Fastest measured</option></select></label>
              <label className="toggle-row"><span><strong>Slow emergency RTX 2000 Ada</strong><small>Add only as the final fallback after the seven ordinary EU-RO-1 candidates.</small></span><input type="checkbox" checked={state.settings.slowEmergencyGpuEnabled} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'slowEmergencyGpuEnabled', value: event.target.checked })} /><i /></label>
            </div>
            {state.pod.matchingPodIds.length > 1 ? (
              <div className="duplicate-pod-card" role="alert"><AlertTriangle size={19} /><div><strong>Duplicate hourly spend detected</strong><small>{state.pod.matchingPodIds.join(' · ')}. Neither Pod will be silently deleted.</small></div></div>
            ) : null}
            <div className="manual-only-card"><ShieldCheck size={18} /><div><strong>Termination is manual only</strong><small>No completed-job event, idle timer, app exit, background monitor, or connectivity failure can terminate a Pod.</small></div></div>
            {state.pod.podId ? <Button tone="danger" onClick={() => dispatch({ type: 'REQUEST_STOP_POD' })}>Stop GPU with confirmation</Button> : <Button tone="primary" icon={Zap} disabled={!['offline', 'error'].includes(state.pod.phase) || state.pod.createRecovery !== null} onClick={() => dispatch({ type: 'START_POD' })}>Start GPU explicitly</Button>}
            <Button icon={Check} disabled={productionLocked} onClick={() => void testConnection()}>Run read-only connection test</Button>
            <details className="advanced-settings">
              <summary><span><Database size={15} /><strong>Advanced connection details</strong></span><ChevronRight size={15} /></summary>
              <dl>
                <div><dt>Volume region</dt><dd>EU-RO-1 · Europe</dd></div>
                <div><dt>Network volume</dt><dd>ukh207b26r · EU-RO-1</dd></div>
                <div><dt>Worker port</dt><dd>8000 / HTTPS proxy</dd></div>
                <div><dt>Model path</dt><dd>/workspace/models/flux2-klein</dd></div>
                <div><dt>Health timeout</dt><dd>12 seconds · 2 misses</dd></div>
                <div><dt>Diagnostics</dt><dd>Prompt + secret logging off</dd></div>
              </dl>
              <p>EU-RO-1 cold order: RTX 4090, RTX PRO 4500 Blackwell, RTX 5090, RTX PRO 4000 Blackwell, L4, RTX A4500, and RTX 4000 Ada. RTX 2000 Ada is slow emergency-only.</p>
            </details>
          </section>

          <section className="panel settings-panel">
            <SettingSectionTitle icon={Sparkles} eyebrow="Generation defaults" title="Portable render contract" />
            <div className="fixed-contract"><div><span>Model</span><strong>black-forest-labs/<br />FLUX.2-klein-4B</strong></div><div><span>Precision</span><strong>BF16</strong></div><div><span>Frame</span><strong>{aspectRatioOption(state.draft.aspectRatio).label} · per batch</strong></div><div><span>Sampler</span><strong>4 steps · 1.0</strong></div></div>
            <label className="toggle-row"><span><strong>Editorial Realism suffix</strong><small>Visible, deterministic text appended to each prompt.</small></span><input type="checkbox" checked={state.settings.editorialSuffixEnabled} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'editorialSuffixEnabled', value: event.target.checked })} /><i /></label>
            <label className="settings-field"><span>Default appended prompt</span><textarea value={state.settings.editorialSuffix} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'editorialSuffix', value: event.target.value })} aria-describedby="settings-suffix-help" /><small id="settings-suffix-help">Saved as the default for every new batch. The switch controls whether it is appended.</small></label>
          </section>

          {adapter.mode !== 'production' ? <section className="panel settings-panel state-lab">
            <SettingSectionTitle icon={Gauge} eyebrow="Deterministic fake adapter" title="Operational state lab" />
            <p className="settings-intro">Preview every authored Pod, ownership, recovery, and batch state without paid compute.</p>
            <label className="scenario-select"><span>State to preview</span><select value={scenario} onChange={(event) => setScenario(event.target.value as OperationalScenario)}>{SCENARIOS.map((item) => <option key={item.id} value={item.id}>{item.label} — {item.note}</option>)}</select></label>
            <div className="simulation-speed"><span><strong>Simulation speed</strong><small>Controls deterministic batch tick frequency.</small></span><div className="segmented-control" role="group" aria-label="Simulation speed">{([1, 4, 12] as const).map((speed) => <button type="button" key={speed} className={state.settings.simulationSpeed === speed ? 'active' : ''} aria-pressed={state.settings.simulationSpeed === speed} onClick={() => dispatch({ type: 'SET_SETTING', key: 'simulationSpeed', value: speed })}>{speed}×</button>)}</div></div>
            <Button tone="primary" icon={Gauge} onClick={() => dispatch({ type: 'PREVIEW_SCENARIO', scenario })}>Load {SCENARIOS.find((item) => item.id === scenario)?.label} state</Button>
          </section> : null}

          {adapter.mode !== 'production' ? <section className="panel settings-panel danger-zone">
            <SettingSectionTitle icon={RotateCcw} eyebrow="Simulation data" title="Reset production desk" />
            <p>Return to the authored offline/empty state. This fake-only action clears the simulated batch and library; it does not touch local files.</p>
            <Button tone="danger" onClick={() => dispatch({ type: 'RESET_WORKSPACE' })}>Reset simulated workspace</Button>
          </section> : null}
        </div>
      </div>
      {showSetup ? <SetupAssistant key={`setup-${setupInitialStep}-${credentialOnlyKind ?? 'full'}`} state={state} dispatch={dispatch} adapter={adapter} initialStep={setupInitialStep} locked={credentialOnlyKind ? activeBatch : productionLocked} credentialOnlyKind={credentialOnlyKind} onClose={() => setShowSetup(false)} /> : null}
    </div>
  );
}
