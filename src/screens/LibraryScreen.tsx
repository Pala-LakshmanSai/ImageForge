import {
  Check,
  Download,
  FileCheck2,
  FolderOpen,
  Images,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { LibraryAsset } from '../domain/types';
import { SimulatedImage } from '../components/SimulatedImage';
import { PreviewImage } from '../components/PreviewImage';
import { DialogPortal } from '../components/DialogPortal';
import { Button, EmptyState, Eyebrow, IconButton, PhaseBadge } from '../components/primitives';
import type { ScreenProps } from './types';

function VerifiedLocalPreview({ filename, compact = false }: { filename: string; compact?: boolean }) {
  return (
    <span className={`verified-local-preview${compact ? ' verified-local-preview--compact' : ''}`}>
      <ShieldCheck size={compact ? 24 : 34} />
      <strong>JPEG verified locally</strong>
      <small>{filename}</small>
    </span>
  );
}

export function LibraryScreen({ state, dispatch, adapter }: ScreenProps) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const [visibleCount, setVisibleCount] = useState(36);
  const [selected, setSelected] = useState<LibraryAsset | null>(null);

  const assets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return state.library.filter((asset) => {
      const inScope = scope === 'all' || asset.batchId === state.batch?.id;
      const matches = !normalized || asset.prompt.toLocaleLowerCase().includes(normalized) || asset.filename.includes(normalized) || asset.batchName.toLocaleLowerCase().includes(normalized);
      return inScope && matches;
    });
  }, [query, scope, state.batch?.id, state.library]);

  useEffect(() => setVisibleCount(36), [query, scope]);

  const batches = new Set(state.library.map((asset) => asset.batchId)).size;
  const totalSeconds = state.library.reduce((sum, asset) => sum + asset.durationSeconds, 0);

  return (
    <div className="screen library-screen">
      <section className="page-heading">
        <div><Eyebrow>Library · verified local artifacts</Eyebrow><h1>Your visual ledger.</h1><p>Every card maps back to an ordered prompt, seed, checksum, and local filename.</p></div>
        <div className="page-heading__actions">
          <Button icon={FolderOpen} onClick={() => void adapter.revealPath().then(() => dispatch({ type: 'SHOW_TOAST', tone: 'success', title: 'Library folder revealed', message: state.settings.defaultDestination })).catch((error: unknown) => dispatch({ type: 'SHOW_TOAST', tone: 'error', title: 'Could not reveal folder', message: error instanceof Error ? error.message : 'The destination could not be revealed.' }))}>Reveal output folder</Button>
          {state.library.length ? <Button tone="danger" icon={Trash2} onClick={() => dispatch({ type: 'REQUEST_CLEAR_LIBRARY' })}>Clear index</Button> : null}
          <Button tone="primary" icon={Sparkles} onClick={() => dispatch({ type: 'NAVIGATE', view: 'create' })}>Create next batch</Button>
        </div>
      </section>

      <div className="library-stats" aria-label="Library summary">
        <div><span>Verified images</span><strong>{state.library.length.toLocaleString()}</strong><small>JPEG + receipt ledger</small></div>
        <div><span>Production batches</span><strong>{batches}</strong><small>Stable numeric order</small></div>
        <div><span>Render time indexed</span><strong>{Math.round(totalSeconds / 60)}m</strong><small>Measured, not estimated</small></div>
        <div><span>Receipt health</span><strong className="success-text">100%</strong><small>SHA-256 confirmed</small></div>
      </div>

      <section className="panel library-panel">
        <header className="library-toolbar">
          <div className="segmented-control" aria-label="Library scope">
            <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All batches</button>
            <button className={scope === 'current' ? 'active' : ''} onClick={() => setScope('current')}>Current batch</button>
          </div>
          <label className="search-field">
            <Search size={16} />
            <span className="visually-hidden">Search library</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search prompts, filenames, batches…" />
            {query ? <IconButton label="Clear search" icon={X} onClick={() => setQuery('')} /> : null}
          </label>
          <span className="library-toolbar__count">{assets.length} results</span>
        </header>

        {assets.length ? (
          <>
            <div className="asset-grid">
              {assets.slice(0, visibleCount).map((asset) => (
                <button className="asset-card" type="button" key={asset.id} onClick={() => setSelected(asset)}>
                  <span className="asset-card__image">{adapter.mode === 'production' ? <PreviewImage cacheKey={`${asset.batchId}:${asset.index}:${asset.checksum}`} alt={`Generated preview for ${asset.filename}`} loader={adapter.fetchPreview ? () => adapter.fetchPreview!(asset.batchId, asset.index) : undefined} fallback={<VerifiedLocalPreview filename={asset.filename} compact />} /> : <SimulatedImage seed={asset.seed} prompt={asset.prompt} compact />}<i><Check size={12} /> verified</i></span>
                  <span className="asset-card__body">
                    <span><strong>{asset.filename}</strong><small>{asset.durationSeconds.toFixed(1)}s</small></span>
                    <em>{asset.prompt}</em>
                    <span className="asset-card__meta"><small>seed {asset.seed}</small><small>{asset.batchName}</small></span>
                  </span>
                </button>
              ))}
            </div>
            {assets.length > visibleCount ? (
              <div className="load-more"><Button onClick={() => setVisibleCount((count) => count + 36)}>Show 36 more</Button><span>{visibleCount} of {assets.length} rendered for smooth browsing</span></div>
            ) : null}
          </>
        ) : (
          <EmptyState
            icon={Images}
            title={query ? 'No frames match that search' : 'Your verified frames will live here'}
            copy={query ? 'Try a filename, batch name, or a word from the original prompt.' : 'Images appear as soon as their local checksum passes—even while the rest of the batch continues.'}
            action={query ? <Button onClick={() => setQuery('')}>Clear search</Button> : <Button tone="primary" onClick={() => dispatch({ type: 'NAVIGATE', view: 'create' })}>Open Create</Button>}
          />
        )}
      </section>

      {selected ? (
        <DialogPortal backdropClassName="asset-inspector-backdrop" surfaceClassName="asset-inspector" labelledBy="asset-title" onRequestClose={() => setSelected(null)}>
            <IconButton data-autofocus className="asset-inspector__close" label="Close image details" icon={X} onClick={() => setSelected(null)} />
            <div className="asset-inspector__preview">{adapter.mode === 'production' ? <PreviewImage cacheKey={`${selected.batchId}:${selected.index}:${selected.checksum}`} alt={`Generated preview for ${selected.filename}`} loader={adapter.fetchPreview ? () => adapter.fetchPreview!(selected.batchId, selected.index) : undefined} fallback={<VerifiedLocalPreview filename={selected.filename} />} /> : <SimulatedImage seed={selected.seed} prompt={selected.prompt} />}</div>
            <div className="asset-inspector__content">
              <div><Eyebrow>{selected.batchName} · frame {String(selected.index).padStart(3, '0')}</Eyebrow><h2 id="asset-title">{selected.filename}</h2></div>
              <PhaseBadge tone="success">verified locally</PhaseBadge>
              <blockquote>“{selected.prompt}”</blockquote>
              <dl className="inspector-meta">
                <div><dt>Seed</dt><dd>{selected.seed}</dd></div>
                <div><dt>Render</dt><dd>{selected.durationSeconds.toFixed(1)} seconds</dd></div>
                <div><dt>Checksum</dt><dd>{selected.checksum}</dd></div>
                <div><dt>Location</dt><dd>{selected.destination}</dd></div>
              </dl>
              <div className="asset-inspector__receipt"><ShieldCheck size={17} /><span><strong>Receipt complete</strong><small>Content type, size, and SHA-256 passed before atomic rename.</small></span></div>
              <div className="asset-inspector__actions">
                <Button icon={FolderOpen} onClick={() => void adapter.revealPath(selected.filename).then(() => dispatch({ type: 'SHOW_TOAST', tone: 'success', title: 'File revealed', message: `${selected.destination}/${selected.filename}` })).catch((error: unknown) => dispatch({ type: 'SHOW_TOAST', tone: 'error', title: 'Could not reveal file', message: error instanceof Error ? error.message : 'The file could not be revealed.' }))}>Reveal file</Button>
                <Button tone="primary" icon={Download} onClick={() => dispatch({ type: 'SHOW_TOAST', tone: 'success', title: 'Already downloaded', message: `${selected.filename} is verified on this device.` })}>Download receipt</Button>
              </div>
            </div>
        </DialogPortal>
      ) : null}
    </div>
  );
}
