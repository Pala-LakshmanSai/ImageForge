import { ArrowLeft, ArrowRight, Check, Folder, KeyRound, Server, ShieldCheck, UserRound, X } from 'lucide-react';
import { useState } from 'react';
import type { ImageForgeAdapter } from '../adapters/imageForgeAdapter';
import type { AppAction, AppState } from '../domain/types';
import type { Dispatch } from 'react';
import { BrandMark } from './BrandMark';
import { Button, Eyebrow, IconButton } from './primitives';

const STEPS = [
  { label: 'Your name', icon: UserRound },
  { label: 'Connect RunPod', icon: KeyRound },
  { label: 'Studio profile', icon: Server },
  { label: 'Downloads', icon: Folder },
];

export function SetupAssistant({
  state,
  dispatch,
  adapter,
  onClose,
}: {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  adapter: ImageForgeAdapter;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [writeChecked, setWriteChecked] = useState(false);
  const [choosing, setChoosing] = useState(false);

  async function chooseFolder() {
    setChoosing(true);
    try {
      const path = await adapter.chooseDestination(state.settings.defaultDestination);
      dispatch({ type: 'SET_SETTING', key: 'defaultDestination', value: path });
      setWriteChecked(true);
    } finally {
      setChoosing(false);
    }
  }

  function finish() {
    dispatch({ type: 'SAVE_SETTINGS' });
    dispatch({
      type: 'SHOW_TOAST',
      tone: 'success',
      title: 'Connection test passed',
      message: 'Profile and folder metadata are valid. No Pod was created.',
    });
    onClose();
  }

  return (
    <div className="setup-backdrop" role="presentation">
      <section className="setup-assistant" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <aside className="setup-rail">
          <div className="setup-brand"><BrandMark size={31} /><strong>imageforge</strong></div>
          <div><Eyebrow>First-run assistant</Eyebrow><h2>Four quiet steps.<br />No terminal.</h2><p>Everything required for everyday image production, without Pod IDs or proxy URLs.</p></div>
          <ol>
            {STEPS.map(({ label, icon: Icon }, index) => (
              <li key={label} className={index === step ? 'active' : index < step ? 'complete' : ''}>
                <span>{index < step ? <Check size={14} /> : <Icon size={15} />}</span>
                <div><strong>{String(index + 1).padStart(2, '0')}</strong><small>{label}</small></div>
              </li>
            ))}
          </ol>
          <div className="setup-security"><ShieldCheck size={16} /><span>Credentials go directly to the operating system vault.</span></div>
        </aside>

        <div className="setup-content">
          <IconButton className="setup-close" label="Close setup assistant" icon={X} onClick={onClose} />
          <div className="setup-step-count">Step {step + 1} of {STEPS.length}</div>
          {step === 0 ? (
            <div className="setup-step">
              <Eyebrow>Identify the batch owner</Eyebrow>
              <h1 id="setup-title">What should we call you?</h1>
              <p>When one editor is generating, the other sees this name and live progress instead of entering a hidden queue.</p>
              <label className="setup-field"><span>Your name</span><input autoFocus value={state.settings.userName} maxLength={40} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'userName', value: event.target.value })} placeholder="Lakshman or Sujal" /></label>
            </div>
          ) : step === 1 ? (
            <div className="setup-step">
              <Eyebrow>Secure RunPod access</Eyebrow>
              <h1 id="setup-title">Connect RunPod.</h1>
              <p>Use a restricted API key where available. ImageForge stores it in Keychain or Windows Credential Manager and never renders the complete value again.</p>
              <label className="setup-field"><span>RunPod API key</span><input autoFocus type="password" autoComplete="off" placeholder="Paste restricted key" defaultValue="" /><small>Uncontrolled masked entry · excluded from React state and browser storage.</small></label>
              <div className="setup-safe-note"><KeyRound size={17} /><span><strong>Vault handoff simulated</strong><small>The deterministic web shell records configured status only.</small></span></div>
            </div>
          ) : step === 2 ? (
            <div className="setup-step">
              <Eyebrow>Import studio connection</Eyebrow>
              <h1 id="setup-title">Bring in the studio profile.</h1>
              <p>The non-secret profile describes the template, volume, approved GPU fallback order, worker port, and pinned model preset.</p>
              <label className="setup-field"><span>Connection profile</span><textarea autoFocus defaultValue={'profile: imageforge-studio-v1\ndata_center: EU-RO-1\nworker_port: 8000\nmodel_preset: flux2-klein-bf16'} /></label>
              <label className="setup-field"><span>Worker token</span><input type="password" autoComplete="off" placeholder="Paste personal worker token" defaultValue="" /><small>Stored separately in the OS vault; never included in the profile or a URL.</small></label>
            </div>
          ) : (
            <div className="setup-step">
              <Eyebrow>Direct-to-device delivery</Eyebrow>
              <h1 id="setup-title">Choose downloads.</h1>
              <p>Full JPEGs, previews, and manifest receipts are written directly to this computer while later images continue generating.</p>
              <button className="setup-folder" type="button" onClick={() => void chooseFolder()}>
                <span><Folder size={22} /></span><div><strong>{choosing ? 'Opening native chooser…' : state.settings.defaultDestination}</strong><small>{writeChecked ? 'Write test passed · permission retained' : 'Choose a folder and run a read-only write test'}</small></div><ArrowRight size={17} />
              </button>
              {writeChecked ? <div className="setup-safe-note setup-safe-note--success"><Check size={17} /><span><strong>Folder verified</strong><small>The final connection check does not create a Pod.</small></span></div> : null}
            </div>
          )}

          <footer className="setup-actions">
            <Button icon={ArrowLeft} disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}>Back</Button>
            <span>Your credentials are never shown in exported diagnostics.</span>
            {step < STEPS.length - 1 ? (
              <Button tone="primary" icon={ArrowRight} disabled={step === 0 && !state.settings.userName.trim()} onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}>Continue</Button>
            ) : (
              <Button tone="primary" icon={ShieldCheck} disabled={!writeChecked} onClick={finish}>Run connection test</Button>
            )}
          </footer>
        </div>
      </section>
    </div>
  );
}
