import {
  AlertCircle,
  ArrowRight,
  Check,
  Circle,
  FileText,
  Folder,
  Gauge,
  HardDrive,
  Image,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Upload,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { canStartBatch } from '../domain/reducer';
import { isReferenceMimeType, MAX_BATCH_REFERENCES, MAX_REFERENCE_TOTAL_BYTES, normalizeReferenceName, validateReferenceBytes } from '../domain/references';
import { ASPECT_RATIOS } from '../domain/aspectRatio';
import type { BatchReference, ReferenceMimeType } from '../domain/types';
import { TERMINAL_BATCH_PHASES } from '../domain/types';
import { Button, Eyebrow, PhaseBadge } from '../components/primitives';
import type { ScreenProps } from './types';

function readiness(state: ScreenProps['state']) {
  return [
    {
      label: 'GPU and model ready',
      detail: state.pod.phase === 'ready' ? `${state.pod.gpu} · BF16 warm` : `Currently ${state.pod.phase}`,
      ready: state.pod.phase === 'ready',
    },
    {
      label: 'Prompt order validated',
      detail: state.draft.prompts.length > 0 ? `${state.draft.prompts.length} ordered prompts` : 'Paste or import prompts',
      ready: state.draft.prompts.length > 0 && !state.draft.issues.some((issue) => issue.level === 'error'),
    },
    {
      label: 'Local destination writable',
      detail: state.draft.destination ?? 'Choose a folder on this device',
      ready: state.draft.destination !== null,
    },
    {
      label: 'Shared batch lock available',
      detail: state.batch ? `${state.batch.owner} · ${state.batch.phase.replace('_', ' ')}` : 'No active generation lease',
      ready: state.batch === null,
    },
  ];
}

function ReferenceThumbnail({ reference }: { reference: BatchReference }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(reference.bytes)], { type: reference.mimeType }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [reference.bytes, reference.mimeType]);
  return src ? <img src={src} alt="" /> : <span className="reference-card__placeholder"><Image size={17} /></span>;
}

function referenceMimeForFile(file: File): string {
  if (isReferenceMimeType(file.type)) return file.type;
  const extension = file.name.toLowerCase().split('.').at(-1);
  return extension === 'jpg' || extension === 'jpeg'
    ? 'image/jpeg'
    : extension === 'png'
      ? 'image/png'
      : extension === 'webp'
        ? 'image/webp'
        : file.type;
}

export function CreateScreen({ state, dispatch, adapter }: ScreenProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [choosingDestination, setChoosingDestination] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [readingReferences, setReadingReferences] = useState(false);
  const errors = state.draft.issues.filter((issue) => issue.level === 'error');
  const warnings = state.draft.issues.filter((issue) => issue.level === 'warning');
  const activeBatch = state.batch && !TERMINAL_BATCH_PHASES.includes(state.batch.phase);
  const destinationLocked = state.batch !== null && !['complete', 'cancelled'].includes(state.batch.phase);
  const terminalBatch = state.batch && TERMINAL_BATCH_PHASES.includes(state.batch.phase);
  const checklist = readiness(state);
  const isReady = canStartBatch(state);

  async function chooseDestination() {
    if (destinationLocked) return;
    setChoosingDestination(true);
    try {
      const path = await adapter.chooseDestination(state.settings.defaultDestination);
      if (path === null) return;
      const valid = await adapter.validateDestination(path);
      if (valid) dispatch({ type: 'SET_DESTINATION', path });
      else dispatch({ type: 'SHOW_TOAST', tone: 'error', title: 'Folder is not writable', message: 'Choose another destination and try the write test again.' });
    } finally {
      setChoosingDestination(false);
    }
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    setReadingFile(true);
    try {
      const text = await file.text();
      dispatch({ type: 'SET_PROMPT_TEXT', text, sourceName: file.name });
      if (state.draft.name === 'Untitled batch') {
        dispatch({ type: 'SET_BATCH_NAME', name: file.name.replace(/\.(txt|csv)$/i, '').replace(/[-_]+/g, ' ') });
      }
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'success',
        title: 'Prompt file imported',
        message: `${file.name} was parsed locally; nothing was uploaded.`,
      });
    } catch {
      dispatch({ type: 'SHOW_TOAST', tone: 'error', title: 'Could not read file', message: 'Choose a UTF-8 TXT or CSV file and try again.' });
    } finally {
      setReadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function importReferences(files: FileList | File[]) {
    const candidates = Array.from(files).slice(0, MAX_BATCH_REFERENCES - state.draft.references.length);
    if (candidates.length === 0) {
      dispatch({ type: 'SHOW_TOAST', tone: 'warning', title: 'Reference limit reached', message: `A batch can use up to ${MAX_BATCH_REFERENCES} references.` });
      return;
    }
    setReadingReferences(true);
    try {
      let addedBytes = 0;
      for (const file of candidates) {
        const mimeType = referenceMimeForFile(file) as ReferenceMimeType;
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        const validation = validateReferenceBytes(mimeType, bytes);
        if (validation !== null) {
          dispatch({ type: 'SHOW_TOAST', tone: 'error', title: 'Reference rejected', message: `${file.name}: ${validation}` });
          continue;
        }
        const existingBytes = state.draft.references.reduce((total, reference) => total + reference.sizeBytes, 0);
        if (existingBytes + addedBytes + bytes.length > MAX_REFERENCE_TOTAL_BYTES) {
          dispatch({ type: 'SHOW_TOAST', tone: 'error', title: 'Reference set is too large', message: `Keep all batch references under ${MAX_REFERENCE_TOTAL_BYTES / (1024 * 1024)} MB.` });
          continue;
        }
        const reference: BatchReference = {
          id: `reference-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: normalizeReferenceName(file.name),
          mimeType,
          sizeBytes: bytes.length,
          bytes,
        };
        dispatch({ type: 'ADD_REFERENCE', reference });
        addedBytes += bytes.length;
      }
    } catch {
      dispatch({ type: 'SHOW_TOAST', tone: 'error', title: 'Could not read reference', message: 'Choose a local JPEG, PNG, or WebP image and try again.' });
    } finally {
      setReadingReferences(false);
      if (referenceInputRef.current) referenceInputRef.current.value = '';
    }
  }

  return (
    <div className="screen create-screen">
      <section className="page-heading page-heading--create">
        <div>
          <Eyebrow>Create · ordered image production</Eyebrow>
          <h1>Direct the frame.</h1>
          <p>One visible prompt per image. No rewriting model, no hidden queue, and no surprise compute.</p>
        </div>
        <div className="page-heading__actions">
          {terminalBatch ? <Button onClick={() => dispatch({ type: 'NEW_BATCH' })}>New brief</Button> : null}
          <Button icon={WandSparkles} onClick={() => dispatch({ type: 'LOAD_SAMPLE' })}>Load sample brief</Button>
          {state.pod.phase !== 'ready' ? (
            <Button tone="primary" icon={Zap} pending={!['offline', 'error'].includes(state.pod.phase)} disabled={!['offline', 'error'].includes(state.pod.phase)} onClick={() => dispatch({ type: 'START_POD' })}>
              {state.pod.phase === 'offline' || state.pod.phase === 'error' ? 'Start GPU' : 'GPU starting'}
            </Button>
          ) : (
            <PhaseBadge tone="success">GPU ready</PhaseBadge>
          )}
        </div>
      </section>

      {activeBatch ? (
        <aside className="lock-banner" role="status">
          <span><LockKeyhole size={20} /></span>
          <div>
            <strong>One active batch is already holding the shared lease</strong>
            <p>{state.batch?.owner} is {state.batch?.phase.replace('_', ' ')} “{state.batch?.name}”. ImageForge does not queue a second batch.</p>
          </div>
          <Button compact onClick={() => dispatch({ type: 'NAVIGATE', view: 'progress' })}>View progress</Button>
        </aside>
      ) : null}

      <div className="create-layout">
        <section className="panel prompt-workbench">
          <header className="panel-heading">
            <div>
              <Eyebrow>01 · Production brief</Eyebrow>
              <h2>Ordered prompt list</h2>
            </div>
            <span className="source-chip"><FileText size={14} /> {state.draft.sourceName ?? 'Pasted text'}</span>
          </header>

          <label className="field-label" htmlFor="batch-name">Batch name</label>
          <input
            id="batch-name"
            className="text-input text-input--title"
            value={state.draft.name}
            onChange={(event) => dispatch({ type: 'SET_BATCH_NAME', name: event.target.value })}
            placeholder="Name this production"
            maxLength={80}
          />

          <div className="prompt-editor">
            <label className="field-label" htmlFor="prompt-list">One prompt per line</label>
            <textarea
              id="prompt-list"
              value={state.draft.rawText}
              onChange={(event) => dispatch({ type: 'SET_PROMPT_TEXT', text: event.target.value, sourceName: null })}
              placeholder={'A quiet observatory above the cloud line at dawn…\nHands restoring a weathered atlas under archival light…'}
              spellCheck="true"
              aria-describedby="prompt-validation"
            />
            <div className="prompt-editor__footer">
              <span className="count" aria-live="polite">
                {state.draft.prompts.length.toLocaleString()} ordered prompts
              </span>
              <span>{state.draft.rawText.length.toLocaleString()} characters · local only</span>
            </div>
          </div>

          <div id="prompt-validation" className={`validation-strip ${errors.length ? 'validation-strip--error' : warnings.length ? 'validation-strip--warning' : state.draft.prompts.length ? 'validation-strip--success' : ''}`}>
            {errors.length ? <AlertCircle size={18} /> : state.draft.prompts.length ? <ShieldCheck size={18} /> : <Circle size={18} />}
            <div>
              <strong>
                {errors.length
                  ? `${errors.length} blocking ${errors.length === 1 ? 'issue' : 'issues'}`
                  : state.draft.prompts.length
                    ? `${state.draft.prompts.length} ordered prompts parsed`
                    : 'Waiting for a brief'}
              </strong>
              <span>
                {errors[0]?.message ??
                  (warnings.length
                    ? `${warnings[0].message}${warnings.length > 1 ? ` · ${warnings.length - 1} more non-blocking ${warnings.length === 2 ? 'note' : 'notes'}` : ''}`
                    : 'TXT and CSV stay on this device until you explicitly start the batch.')}
              </span>
            </div>
          </div>

          <div className="prompt-workbench__actions">
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept=".txt,.csv,text/plain,text/csv"
              onChange={(event) => void importFile(event.target.files?.[0])}
            />
            <Button icon={Upload} pending={readingFile} onClick={() => fileInputRef.current?.click()}>Import TXT or CSV</Button>
            {state.draft.rawText ? (
              <Button tone="quiet" onClick={() => dispatch({ type: 'SET_PROMPT_TEXT', text: '', sourceName: null })}>Clear prompts</Button>
            ) : null}
          </div>
        </section>

        <aside className="create-sidebar">
          <section className="panel reference-panel">
            <header className="panel-heading panel-heading--compact">
              <div><Eyebrow>Optional visual anchor</Eyebrow><h2>Batch references</h2></div>
              <Image size={20} />
            </header>
            <p className="reference-panel__intro">References apply to every prompt in this batch. They stay local until you explicitly start generation.</p>
            <label
              className="reference-dropzone"
              htmlFor="reference-files"
              aria-busy={readingReferences}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void importReferences(event.dataTransfer.files);
              }}
            >
              <input
                ref={referenceInputRef}
                id="reference-files"
                className="visually-hidden"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(event) => void importReferences(event.target.files ?? [])}
              />
              <Upload size={17} />
              <strong>{readingReferences ? 'Reading references…' : 'Choose or drop images'}</strong>
              <small>JPEG, PNG, or WebP · up to {MAX_BATCH_REFERENCES}</small>
            </label>
            {state.draft.references.length > 0 ? (
              <div className="reference-grid" aria-label={`${state.draft.references.length} batch references`}>
                {state.draft.references.map((reference) => (
                  <article className="reference-card" key={reference.id}>
                    <ReferenceThumbnail reference={reference} />
                    <div className="reference-card__meta">
                      <strong title={reference.name}>{reference.name}</strong>
                      <small>{reference.mimeType.replace('image/', '').toUpperCase()} · {(reference.sizeBytes / (1024 * 1024)).toFixed(1)} MB</small>
                    </div>
                    <button
                      type="button"
                      className="reference-card__remove"
                      aria-label={`Remove ${reference.name}`}
                      disabled={destinationLocked}
                      onClick={() => dispatch({ type: 'REMOVE_REFERENCE', id: reference.id })}
                    ><X size={14} /></button>
                  </article>
                ))}
              </div>
            ) : null}
          </section>
          <section className="panel destination-panel">
            <header className="panel-heading panel-heading--compact">
              <div><Eyebrow>02 · Local delivery</Eyebrow><h2>Destination</h2></div>
              <HardDrive size={20} />
            </header>
            <button className="folder-picker" type="button" disabled={destinationLocked || choosingDestination} onClick={() => void chooseDestination()} aria-busy={choosingDestination}>
              <span><Folder size={21} /></span>
              <span>
                <strong>{choosingDestination ? 'Opening folder chooser…' : state.draft.destination ? state.draft.destination.split(/[\\/]/).at(-1) : 'Choose output folder'}</strong>
                <small>{state.draft.destination ?? 'JPEGs, previews, and manifest.csv'}</small>
              </span>
              <ArrowRight size={17} />
            </button>
            <p className="security-note"><ShieldCheck size={14} /> Files arrive as <code>.part</code>, pass checksum verification, then rename atomically.</p>
          </section>

          <section className="panel contract-panel">
            <header className="panel-heading panel-heading--compact">
              <div><Eyebrow>Fixed render contract</Eyebrow><h2>One honest model</h2></div>
              <Sparkles size={20} />
            </header>
            <dl className="contract-grid">
              <div><dt>Model</dt><dd>FLUX.2 Klein 4B</dd></div>
              <div><dt>Output</dt><dd>{ASPECT_RATIOS.find((option) => option.value === state.draft.aspectRatio)?.width} × {ASPECT_RATIOS.find((option) => option.value === state.draft.aspectRatio)?.height} JPEG</dd></div>
              <div><dt>Precision</dt><dd>BF16</dd></div>
              <div><dt>Sampling</dt><dd>4 steps · 1.0 guidance</dd></div>
            </dl>
            <div className="aspect-ratio-picker">
              <div className="settings-field__label"><span>Aspect ratio</span><small>Choose the delivery shape for every image in this batch.</small></div>
              <div className="aspect-ratio-grid" role="radiogroup" aria-label="Image aspect ratio">
                {ASPECT_RATIOS.map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    className={`aspect-ratio-option ${state.draft.aspectRatio === option.value ? 'aspect-ratio-option--selected' : ''}`}
                    role="radio"
                    aria-checked={state.draft.aspectRatio === option.value}
                    onClick={() => dispatch({ type: 'SET_ASPECT_RATIO', aspectRatio: option.value })}
                    disabled={destinationLocked}
                  >
                    <span className={`aspect-ratio-glyph aspect-ratio-glyph--${option.value.replace(':', '-')}`} aria-hidden="true" />
                    <strong>{option.label}</strong>
                    <small>{option.use}</small>
                  </button>
                ))}
              </div>
            </div>
            <label className="toggle-row">
              <span><strong>Editorial Realism suffix</strong><small>Visible style direction; never rewritten by an LLM.</small></span>
              <input
                type="checkbox"
                checked={state.settings.editorialSuffixEnabled}
                onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'editorialSuffixEnabled', value: event.target.checked })}
              />
              <i aria-hidden="true" />
            </label>
            <label className="settings-field create-suffix-field" htmlFor="create-editorial-suffix">
              <span>Edit visible suffix</span>
              <textarea
                id="create-editorial-suffix"
                value={state.settings.editorialSuffix}
                onChange={(event) => dispatch({ type: 'SET_SETTING', key: 'editorialSuffix', value: event.target.value })}
                aria-describedby="create-editorial-suffix-help"
              />
              <small id="create-editorial-suffix-help">Appended after each submitted prompt when enabled; surrounding whitespace is normalized.</small>
            </label>
          </section>

          <section className={`panel launch-panel ${isReady ? 'launch-panel--ready' : ''}`}>
            <header className="panel-heading panel-heading--compact">
              <div><Eyebrow>03 · Launch check</Eyebrow><h2>{isReady ? 'Ready to forge' : 'Complete the setup'}</h2></div>
              <Gauge size={20} />
            </header>
            <ul className="readiness-list">
              {checklist.map((item) => (
                <li key={item.label} className={item.ready ? 'readiness-list__ready' : ''}>
                  <span>{item.ready ? <Check size={14} /> : <Circle size={14} />}</span>
                  <div><strong>{item.label}</strong><small>{item.detail}</small></div>
                </li>
              ))}
            </ul>
            <Button
              className="launch-button"
              tone="primary"
              icon={Sparkles}
              disabled={!isReady}
              onClick={() => dispatch({ type: 'START_BATCH', startedAt: new Date().toISOString() })}
            >
              Generate {state.draft.prompts.length || ''} ordered images
            </Button>
            <p className="launch-panel__foot">Starting generation never enables automatic GPU shutdown.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
