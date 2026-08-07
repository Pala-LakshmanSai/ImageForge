import { ArrowLeft, ArrowRight, Check, Folder, KeyRound, Server, ShieldCheck, UserRound, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type Dispatch } from 'react';
import type { ImageForgeAdapter } from '../adapters/imageForgeAdapter';
import type { AppAction, AppState, CredentialKind } from '../domain/types';
import { userFacingErrorMessage } from '../native/userFacingError';
import { BrandMark } from './BrandMark';
import { DialogPortal } from './DialogPortal';
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
  initialStep = 0,
  canClose = true,
  locked = false,
  credentialOnlyKind,
}: {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  adapter: ImageForgeAdapter;
  onClose?: () => void;
  initialStep?: number;
  canClose?: boolean;
  locked?: boolean;
  credentialOnlyKind?: CredentialKind;
}) {
  const credentialOnlyStep = credentialOnlyKind === 'runpodApiKey' ? 1 : 2;
  const credentialOnly = credentialOnlyKind !== undefined;
  const [step, setStep] = useState(credentialOnly ? credentialOnlyStep : Math.min(STEPS.length - 1, Math.max(0, initialStep)));
  const [writeChecked, setWriteChecked] = useState(state.setup.destinationValidated);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const workerTokenRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // The dialog's initial focus effect runs only when it mounts. Each setup
  // step replaces its form controls, so explicitly move focus to the first
  // control after a keyboard user advances or goes back.
  useLayoutEffect(() => {
    contentRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [step]);

  async function chooseFolder() {
    if (locked) {
      setError('Finish or cancel the active ImageForge batch before changing its destination.');
      return;
    }
    setChoosing(true);
    setError(null);
    setWriteChecked(false);
    dispatch({ type: 'SET_DESTINATION_VALIDATED', validated: false });
    try {
      const path = await adapter.chooseDestination(state.settings.defaultDestination);
      if (path === null) return;
      const valid = await adapter.validateDestination(path);
      dispatch({ type: 'SET_SETTING', key: 'defaultDestination', value: path });
      dispatch({ type: 'SET_DESTINATION_VALIDATED', validated: valid });
      setWriteChecked(valid);
      if (!valid) setError('That folder is not writable. Choose another destination.');
    } finally {
      setChoosing(false);
    }
  }

  async function saveCredential(kind: CredentialKind, value: string) {
    if (locked && !credentialOnly) return;
    const metadata = await adapter.replaceCredential(kind, value);
    dispatch({
      type: 'SET_CREDENTIAL_METADATA',
      credentials: { ...state.setup.credentials, [kind]: metadata },
    });
  }

  async function continueSetup() {
    if (locked && !credentialOnly) {
      setError('Finish or cancel the active ImageForge batch before changing connection settings.');
      return;
    }
    setError(null);
    if (credentialOnly) {
      const input = credentialOnlyKind === 'runpodApiKey' ? apiKeyRef.current : workerTokenRef.current;
      const value = input?.value.trim() ?? '';
      if (input) input.value = '';
      if (!value) {
        setError(`Paste the ${credentialOnlyKind === 'runpodApiKey' ? 'RunPod API key' : 'worker token'} before saving.`);
        return;
      }
      setBusy(true);
      try {
        await saveCredential(credentialOnlyKind, value);
        const label = credentialOnlyKind === 'runpodApiKey' ? 'RunPod API key' : 'Worker credential';
        dispatch({ type: 'SHOW_TOAST', tone: 'success', title: `${label} replaced`, message: `The new ${label.toLowerCase()} stays in the operating-system vault.` });
        onClose?.();
      } catch (caught) {
        setError(userFacingErrorMessage(caught, 'Could not save that credential.'));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (step === 0) {
      if (!state.settings.userName.trim()) {
        setError('Enter the name teammates should see on an active batch.');
        return;
      }
      setStep(1);
      return;
    }

    setBusy(true);
    try {
      if (step === 1) {
        const input = apiKeyRef.current;
        const value = input?.value.trim() ?? '';
        if (input) input.value = '';
        if (!value && !state.setup.credentials.runpodApiKey.configured) {
          setError('Paste a RunPod API key before continuing.');
          return;
        }
        if (value) await saveCredential('runpodApiKey', value);
        setStep(2);
        return;
      }

      const validProfile = await adapter.validateStudioProfile(state.setup.studioProfile);
      if (!validProfile) {
        setError('The profile must include the EU-RO-1 template, volume, GPU policy, worker port, and model preset.');
        return;
      }
      const input = workerTokenRef.current;
      const value = input?.value.trim() ?? '';
      if (input) input.value = '';
      if (!value && !state.setup.credentials.workerToken.configured) {
        setError('Paste your worker token before continuing.');
        return;
      }
      if (value) await saveCredential('workerToken', value);
      setStep(3);
    } catch (caught) {
      setError(userFacingErrorMessage(caught, 'Could not validate that setup value.'));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (locked) {
      setError('Finish or cancel the active ImageForge batch before changing connection settings.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const credentials = await adapter.credentialMetadata();
      dispatch({ type: 'SET_CREDENTIAL_METADATA', credentials });
      const result = await adapter.testConnection({
        profile: state.setup.studioProfile,
        destination: state.settings.defaultDestination,
        destinationValidated: writeChecked,
        credentials,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      dispatch({ type: 'COMPLETE_SETUP' });
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'success',
        title: 'Connection test passed',
        message: result.message,
      });
      onClose?.();
    } catch (caught) {
      setError(userFacingErrorMessage(caught, 'The connection test could not be completed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogPortal
      backdropClassName="setup-backdrop"
      surfaceClassName="setup-assistant"
      labelledBy="setup-title"
      onRequestClose={canClose ? onClose : undefined}
      closeOnBackdrop={false}
    >
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
        <div className="setup-security"><ShieldCheck size={16} /><span>Credentials go directly to the operating system vault abstraction.</span></div>
      </aside>

      <div ref={contentRef} className="setup-content">
        {canClose ? <IconButton className="setup-close" label="Close setup assistant" icon={X} onClick={onClose} /> : null}
        <div className="setup-step-count">{credentialOnly ? 'Credential replacement' : `Step ${step + 1} of ${STEPS.length}`}</div>
        {step === 0 ? (
          <div className="setup-step" key="identity-step">
            <Eyebrow>Identify the batch owner</Eyebrow>
            <h1 id="setup-title">What should we call you?</h1>
            <p>When one editor is generating, the other sees this name and live progress instead of entering a hidden queue.</p>
            <label className="setup-field"><span>Your name</span><input key="owner-name" disabled={locked} data-autofocus autoFocus value={state.settings.userName} maxLength={40} onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'userName', value: event.target.value })} placeholder="Lakshman or Sujal" /></label>
          </div>
        ) : step === 1 ? (
          <div className="setup-step" key="runpod-key-step">
            <Eyebrow>Secure RunPod access</Eyebrow>
            <h1 id="setup-title">Connect RunPod.</h1>
            <p>Use a restricted API key where available. ImageForge records only configured status and a redacted suffix after the vault handoff.</p>
            <label className="setup-field"><span>RunPod API key</span><input aria-label="RunPod API key" key="runpod-api-key" ref={apiKeyRef} disabled={locked} data-autofocus autoFocus type="password" autoComplete="off" placeholder={state.setup.credentials.runpodApiKey.configured ? `Configured · •••• ${state.setup.credentials.runpodApiKey.suffix}` : 'Paste restricted key'} /><small>The deterministic shell discards the complete value after the adapter returns redacted metadata.</small></label>
            <div className="setup-safe-note"><KeyRound size={17} /><span><strong>{state.setup.credentials.runpodApiKey.configured ? 'RunPod key configured' : 'Vault handoff required'}</strong><small>{state.setup.credentials.runpodApiKey.provider}</small></span></div>
          </div>
        ) : step === 2 ? (
          <div className="setup-step" key="studio-profile-step">
            <Eyebrow>Import studio connection</Eyebrow>
            <h1 id="setup-title">Bring in the studio profile.</h1>
            <p>The non-secret profile describes the template, volume, ten-GPU EU-RO-1 policy, worker port, and pinned model preset.</p>
            <label className="setup-field"><span>Connection profile</span><textarea key="studio-profile" readOnly={locked || credentialOnly} data-autofocus={!credentialOnly} value={state.setup.studioProfile} onChange={(event) => dispatch({ type: 'SET_STUDIO_PROFILE', profile: event.target.value })} /></label>
            <label className="setup-field"><span>Worker token</span><input aria-label="Worker token" key="worker-token" ref={workerTokenRef} disabled={locked && !credentialOnly} data-autofocus={credentialOnly} type="password" autoComplete="off" placeholder={state.setup.credentials.workerToken.configured ? `Configured · •••• ${state.setup.credentials.workerToken.suffix}` : 'Paste personal worker token'} /><small>Stored separately; never included in the profile or a URL.</small></label>
          </div>
        ) : (
          <div className="setup-step" key="downloads-step">
            <Eyebrow>Direct-to-device delivery</Eyebrow>
            <h1 id="setup-title">Choose downloads.</h1>
            <p>Full-quality images are saved directly to this computer while later images continue generating.</p>
            <button className="setup-folder" type="button" data-autofocus autoFocus disabled={locked} onClick={() => void chooseFolder()}>
              <span><Folder size={22} /></span><div><strong>{choosing ? 'Opening native chooser…' : state.settings.defaultDestination}</strong><small>{writeChecked ? 'Write test passed · permission retained' : 'Choose a folder and run a write test'}</small></div><ArrowRight size={17} />
            </button>
            {writeChecked ? <div className="setup-safe-note setup-safe-note--success"><Check size={17} /><span><strong>Folder ready</strong><small>The final connection check does not start a GPU.</small></span></div> : null}
          </div>
        )}

        {error ? <p className="setup-error" role="alert">{error}</p> : null}
        <footer className="setup-actions">
          <Button icon={ArrowLeft} disabled={credentialOnly || step === 0 || busy} onClick={() => { setError(null); setStep((value) => Math.max(0, value - 1)); }}>Back</Button>
          <span>Your credentials are never shown in exported diagnostics.</span>
          {credentialOnly ? (
            <Button tone="primary" icon={ShieldCheck} pending={busy} disabled={busy} onClick={() => void continueSetup()}>Save {credentialOnlyKind === 'runpodApiKey' ? 'RunPod API key' : 'worker credential'}</Button>
          ) : step < STEPS.length - 1 ? (
            <Button tone="primary" icon={ArrowRight} pending={busy} disabled={locked || busy || (step === 0 && !state.settings.userName.trim())} onClick={() => void continueSetup()}>Continue</Button>
          ) : (
            <Button tone="primary" icon={ShieldCheck} pending={busy} disabled={locked || !writeChecked || busy} onClick={() => void finish()}>Run connection test</Button>
          )}
        </footer>
      </div>
    </DialogPortal>
  );
}
