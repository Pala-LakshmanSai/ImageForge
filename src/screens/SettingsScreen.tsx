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
import { podPowerAction, type CredentialKind, type OperationalScenario } from '../domain/types';
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
  { id: 'running', label: 'Running', note: 'Images generating and saving' },
  { id: 'paused', label: 'Paused', note: 'Owner retains batch lock' },
  { id: 'locked', label: 'Locked', note: 'Other user owns batch' },
  { id: 'duplicate_pods', label: 'Duplicate Pods', note: 'Manual cost warning' },
  { id: 'reconnecting', label: 'Reconnecting', note: 'Connection recovery' },
  { id: 'partial_failure', label: 'Partial failure', note: 'Retry failed slots only' },
  { id: 'complete', label: 'Complete', note: 'All images saved' },
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
  const powerAction = podPowerAction(state.pod);
  const productionLocked = adapter.mode === 'production' && (
    powerAction === 'stop' ||
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
        <div><Eyebrow>This device</Eyebrow><h1>Settings</h1><p>Output folder, account details, GPU controls, and image defaults.</p></div>
        <div className="page-heading__actions">
          <Button icon={Laptop} disabled={productionLocked} onClick={() => openSetup()}>Setup</Button>
          <PhaseBadge tone="success"><ShieldCheck size={13} /> secrets hidden</PhaseBadge>
          <Button tone="primary" icon={Save} onClick={() => dispatch({ type: 'SAVE_SETTINGS' })}>Save preferences</Button>
        </div>
      </section>

      <div className="settings-layout">
        <div className="settings-column">
          <section className="panel settings-panel">
            <SettingSectionTitle icon={UserRound} eyebrow="Profile" title="Name and output" />
            <div className="settings-form-grid">
              <label className="settings-field"><span>Display name</span><small>Shown to the other user when you run a batch.</small><input value={state.settings.userName} maxLength={40} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'userName', value: event.target.value })} /></label>
              <label className="settings-field"><span>Default output folder</span><small>Where completed images are saved on this device.</small><button type="button" className="settings-picker" disabled={productionLocked || choosingDestination} onClick={() => void chooseDefaultDestination()}><Folder size={16} /><strong>{choosingDestination ? 'Opening chooser…' : state.settings.defaultDestination}</strong><ChevronRight size={15} /></button></label>
            </div>
          </section>

          <section className="panel settings-panel">
            <SettingSectionTitle icon={KeyRound} eyebrow="Connection" title="Saved credentials" />
            <p className="settings-intro">Credentials stay in your system vault. Only status and the last four characters appear here.</p>
            <div className="credential-list">
              <article className="credential-card">
                <span className="credential-card__icon"><KeyRound size={18} /></span>
                <div><strong>RunPod API key</strong><small>{state.setup.credentials.runpodApiKey.configured ? `Configured · ends in •••• ${state.setup.credentials.runpodApiKey.suffix} · ${state.setup.credentials.runpodApiKey.provider}` : `Not configured · ${state.setup.credentials.runpodApiKey.provider}`}</small></div>
                <PhaseBadge tone={state.setup.credentials.runpodApiKey.configured ? 'success' : 'warning'}>{state.setup.credentials.runpodApiKey.configured ? 'configured' : 'required'}</PhaseBadge>
                <Button compact disabled={activeBatch} onClick={() => openSetup(1, 'runpodApiKey')}>Replace</Button>
              </article>
              <article className="credential-card">
                <span className="credential-card__icon"><LockKeyhole size={18} /></span>
                <div><strong>Worker access key</strong><small>{state.setup.credentials.workerToken.configured ? `Configured · ends in •••• ${state.setup.credentials.workerToken.suffix} · never shown in a URL` : `Not configured · ${state.setup.credentials.workerToken.provider}`}</small></div>
                <PhaseBadge tone={state.setup.credentials.workerToken.configured ? 'success' : 'warning'}>{state.setup.credentials.workerToken.configured ? 'configured' : 'required'}</PhaseBadge>
                <Button compact disabled={activeBatch} onClick={() => openSetup(2, 'workerToken')}>Replace</Button>
              </article>
            </div>
            <div className="redaction-note"><EyeOff size={17} /><span><strong>Secrets stay hidden</strong><small>They are excluded from the screen, logs, crash reports, and project files.</small></span></div>
          </section>

          <section className="panel settings-panel">
            <SettingSectionTitle icon={MonitorCog} eyebrow="Interface" title="Appearance" />
            <div className="setting-rows">
              <label className="select-row"><span><strong>Theme</strong><small>Both modes preserve the dark production-console contrast.</small></span><select value={state.settings.theme} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'theme', value: event.target.value as 'midnight' | 'ink' })}><option value="midnight">Midnight cobalt</option><option value="ink">Deep ink</option></select></label>
              <label className="select-row"><span><strong>Information density</strong><small>Compact keeps long prompt-list reviews efficient.</small></span><select value={state.settings.density} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'density', value: event.target.value as 'comfortable' | 'compact' })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
            </div>
          </section>
        </div>

        <div className="settings-column">
          <section className="panel settings-panel">
            <SettingSectionTitle icon={Server} eyebrow="GPU control" title="One GPU at a time" />
            <div className="pod-attachment-card">
              <div className="pod-attachment-card__top"><span><Zap size={20} /></span><div><strong>{powerAction === 'stop' ? state.pod.gpu ?? 'GPU identity unavailable' : 'No active compute'}</strong><small>{powerAction === 'stop' ? `${state.pod.hourlyRate === null ? 'Rate unavailable' : `$${state.pod.hourlyRate.toFixed(2)}/hr`} · exact Pod attached` : 'Starts only when you click Start GPU.'}</small></div><PhaseBadge tone={state.pod.phase === 'ready' && powerAction === 'stop' ? 'success' : state.pod.phase === 'error' ? 'danger' : 'neutral'}>{state.pod.phase === 'ready' && powerAction === 'start' ? 'identity needed' : state.pod.phase}</PhaseBadge></div>
              <dl><div><dt>Approved GPUs</dt><dd>{state.settings.slowEmergencyGpuEnabled ? '8 types' : '7 types'}</dd></div><div><dt>Region</dt><dd>EU-RO-1 Secure</dd></div><div><dt>Selection</dt><dd>{state.settings.gpuPreference === 'best_value' ? 'Best measured value' : 'Fastest measured'}</dd></div><div><dt>Shutdown</dt><dd>Manual only</dd></div></dl>
            </div>
            <div className="setting-rows pod-preferences">
              <label className="select-row"><span><strong>GPU preference</strong><small>Ranks the compatible pool; it never pins one GPU model.</small></span><select value={state.settings.gpuPreference} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'gpuPreference', value: event.target.value as 'best_value' | 'fastest' })}><option value="best_value">Best whole-batch value</option><option value="fastest">Fastest measured</option></select></label>
              <label className="toggle-row"><span><strong>Slow emergency RTX 2000 Ada</strong><small>Add only as the final fallback after the ten ordinary EU-RO-1 candidates.</small></span><input type="checkbox" checked={state.settings.slowEmergencyGpuEnabled} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'slowEmergencyGpuEnabled', value: event.target.checked })} /><i /></label>
            </div>
            {state.pod.matchingPodIds.length > 1 ? (
              <div className="duplicate-pod-card" role="alert"><AlertTriangle size={19} /><div><strong>Duplicate hourly spend detected</strong><small>{state.pod.matchingPodIds.join(' · ')}. Neither Pod will be silently deleted.</small></div></div>
            ) : null}
            <div className="manual-only-card"><ShieldCheck size={18} /><div><strong>GPU stops only when you confirm</strong><small>Finishing a batch, closing the app, idling, or losing connection will not stop it.</small></div></div>
            {powerAction === 'stop' ? <Button tone="danger" onClick={() => dispatch({ type: 'REQUEST_STOP_POD' })}>Stop GPU with confirmation</Button> : <Button tone="primary" icon={Zap} disabled={!['offline', 'error'].includes(state.pod.phase) || state.pod.createRecovery !== null} onClick={() => dispatch({ type: 'START_POD' })}>{state.pod.phase === 'ready' ? 'GPU identity needed' : 'Start GPU explicitly'}</Button>}
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
              <p>EU-RO-1 cold order includes RTX 4090, RTX PRO 4500/4000 Blackwell, RTX 5090, L4, RTX A4500, RTX 4000 Ada, A100 PCIe, and both RTX PRO 6000 Blackwell editions. RTX 2000 Ada is slow emergency-only; B200 remains excluded.</p>
            </details>
          </section>

          <section className="panel settings-panel">
            <SettingSectionTitle icon={Sparkles} eyebrow="Image defaults" title="Output and style" />
            <div className="fixed-contract"><div><span>Model</span><strong>Comfy-Org/<br />Mage-Flow-Turbo</strong></div><div><span>Precision</span><strong>INT8</strong></div><div><span>Frame</span><strong>{aspectRatioOption(state.draft.aspectRatio).label} · per batch</strong></div><div><span>Sampler</span><strong>4 steps · 1.0</strong></div></div>
            <label className="toggle-row"><span><strong>Optional style instruction</strong><small>{state.settings.editorialSuffixEnabled ? 'On — added to every prompt.' : 'Off — prompts are sent exactly as written.'}</small></span><input type="checkbox" checked={state.settings.editorialSuffixEnabled} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'editorialSuffixEnabled', value: event.target.checked })} /><i /></label>
            <label className="settings-field"><span>Style instruction</span><textarea value={state.settings.editorialSuffix} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'editorialSuffix', value: event.target.value })} aria-describedby="settings-suffix-help" /><small id="settings-suffix-help">Saved for new batches and used only when the switch is on.</small></label>
          </section>

          {adapter.mode !== 'production' ? <section className="panel settings-panel state-lab">
            <SettingSectionTitle icon={Gauge} eyebrow="Deterministic fake adapter" title="Operational state lab" />
            <p className="settings-intro">Preview every authored Pod, ownership, recovery, and batch state without paid compute.</p>
            <label className="scenario-select"><span>State to preview</span><select value={scenario} onChange={(event) => setScenario(event.target.value as OperationalScenario)}>{SCENARIOS.map((item) => <option key={item.id} value={item.id}>{item.label} — {item.note}</option>)}</select></label>
            <div className="simulation-speed"><span><strong>Simulation speed</strong><small>Controls deterministic batch tick frequency.</small></span><div className="segmented-control" role="group" aria-label="Simulation speed">{([1, 4, 12] as const).map((speed) => <button type="button" key={speed} className={state.settings.simulationSpeed === speed ? 'active' : ''} aria-pressed={state.settings.simulationSpeed === speed} onClick={() => dispatch({ type: 'SET_SETTING', key: 'simulationSpeed', value: speed })}>{speed}×</button>)}</div></div>
            <Button tone="primary" icon={Gauge} onClick={() => dispatch({ type: 'PREVIEW_SCENARIO', scenario })}>Load {SCENARIOS.find((item) => item.id === scenario)?.label} state</Button>
          </section> : null}

          {adapter.mode !== 'production' ? <section className="panel settings-panel danger-zone">
            <SettingSectionTitle icon={RotateCcw} eyebrow="Test data" title="Reset workspace" />
            <p>Return to the authored offline/empty state. This fake-only action clears the simulated batch and library; it does not touch local files.</p>
            <Button tone="danger" onClick={() => dispatch({ type: 'RESET_WORKSPACE' })}>Reset simulated workspace</Button>
          </section> : null}
        </div>
      </div>
      {showSetup ? <SetupAssistant key={`setup-${setupInitialStep}-${credentialOnlyKind ?? 'full'}`} state={state} dispatch={dispatch} adapter={adapter} initialStep={setupInitialStep} locked={credentialOnlyKind ? activeBatch : productionLocked} credentialOnlyKind={credentialOnlyKind} onClose={() => setShowSetup(false)} /> : null}
    </div>
  );
}
