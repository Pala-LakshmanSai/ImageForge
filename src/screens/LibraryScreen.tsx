import {
  Download,
  FolderOpen,
  Images,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { LibraryAsset } from '../domain/types';
import { DialogPortal } from '../components/DialogPortal';
import { PreviewImage } from '../components/PreviewImage';
import { SimulatedImage } from '../components/SimulatedImage';
import { Button, EmptyState, Eyebrow, IconButton } from '../components/primitives';
import type { ImageForgeAdapter } from '../adapters/imageForgeAdapter';
import type { ScreenProps } from './types';

const INITIAL_VISIBLE_ASSETS = 36;

function frameNumber(index: number): string {
  return String(index).padStart(3, '0');
}

function frameLabel(asset: LibraryAsset): string {
  return asset.batchName + ' · ' + frameNumber(asset.index);
}

function formattedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function LibraryImageState({
  state,
  large = false,
}: {
  state: 'loading' | 'unavailable';
  large?: boolean;
}) {
  return (
    <span
      className={
        'library-image-state library-image-state--' + state
        + (large ? ' library-image-state--large' : '')
      }
      role={state === 'unavailable' ? 'status' : undefined}
    >
      <Images size={large ? 32 : 22} aria-hidden="true" />
      <strong>{state === 'loading' ? 'Loading full-quality image' : 'Image unavailable'}</strong>
      <small>
        {state === 'loading'
          ? 'Reading the saved JPEG'
          : 'The saved image could not be opened.'}
      </small>
    </span>
  );
}

function LibraryAssetImage({
  asset,
  adapter,
  large = false,
}: {
  asset: LibraryAsset;
  adapter: ImageForgeAdapter;
  large?: boolean;
}) {
  if (adapter.mode !== 'production') {
    return <SimulatedImage seed={asset.seed} prompt={asset.prompt} compact />;
  }

  const loader = adapter.fetchPreview
    ? () => adapter.fetchPreview!(asset.batchId, asset.index)
    : undefined;
  return (
    <PreviewImage
      cacheKey={asset.batchId + ':' + asset.index}
      expectedSha256={asset.checksum}
      alt={'Generated image for ' + frameLabel(asset)}
      loader={loader}
      loading={large ? 'eager' : 'lazy'}
      fallback={
        <LibraryImageState state={loader ? 'loading' : 'unavailable'} large={large} />
      }
      errorFallback={<LibraryImageState state="unavailable" large={large} />}
      className="library-image"
    />
  );
}

export function LibraryScreen({ state, dispatch, adapter }: ScreenProps) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ASSETS);
  const [selected, setSelected] = useState<LibraryAsset | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const assets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return state.library.filter((asset) => {
      const inScope = scope === 'all' || asset.batchId === state.batch?.id;
      const matches = !normalized
        || asset.prompt.toLocaleLowerCase().includes(normalized)
        || asset.filename.toLocaleLowerCase().includes(normalized)
        || asset.batchName.toLocaleLowerCase().includes(normalized);
      return inScope && matches;
    });
  }, [query, scope, state.batch?.id, state.library]);

  useEffect(() => setVisibleCount(INITIAL_VISIBLE_ASSETS), [query, scope]);

  const batches = new Set(state.library.map((asset) => asset.batchId)).size;
  const latestBatch = state.library[0]?.batchName ?? 'No batches yet';

  async function downloadAsset(asset: LibraryAsset): Promise<void> {
    if (downloadingId !== null) return;
    setDownloadingId(asset.id);
    try {
      if (!adapter.downloadAsset) {
        throw new Error('Image download is not available in this build.');
      }
      const savedPath = await adapter.downloadAsset({
        batchId: asset.batchId,
        index: asset.index,
        batchName: asset.batchName,
        checksum: asset.checksum,
      });
      if (savedPath === null) return;
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'success',
        title: 'Image downloaded',
        message: frameLabel(asset) + ' was saved as a new file.',
      });
    } catch (error) {
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'error',
        title: 'Download failed',
        message: error instanceof Error ? error.message : 'The image could not be downloaded.',
      });
    } finally {
      setDownloadingId(null);
    }
  }

  async function showInFolder(asset: LibraryAsset): Promise<void> {
    try {
      await adapter.revealPath(asset.filename);
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'success',
        title: 'Image shown in folder',
        message: frameLabel(asset) + ' is selected.',
      });
    } catch (error) {
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'error',
        title: 'Could not show image',
        message: error instanceof Error ? error.message : 'The image folder could not be opened.',
      });
    }
  }

  return (
    <div className="screen library-screen">
      <section className="page-heading">
        <div>
          <Eyebrow>Library</Eyebrow>
          <h1>Your images.</h1>
          <p>Browse finished frames, download a copy, or open their folder.</p>
        </div>
        <div className="page-heading__actions">
          <Button
            icon={FolderOpen}
            onClick={() => {
              void adapter.revealPath()
                .then(() => dispatch({
                  type: 'SHOW_TOAST',
                  tone: 'success',
                  title: 'Output folder opened',
                  message: 'Your ImageForge images are ready to browse.',
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
            Show output folder
          </Button>
          {state.library.length ? (
            <Button
              tone="danger"
              icon={Trash2}
              onClick={() => dispatch({ type: 'REQUEST_CLEAR_LIBRARY' })}
            >
              Clear library
            </Button>
          ) : null}
          <Button
            tone="primary"
            icon={Sparkles}
            onClick={() => dispatch({ type: 'NAVIGATE', view: 'create' })}
          >
            New batch
          </Button>
        </div>
      </section>

      <div className="library-stats" role="group" aria-label="Library summary">
        <div>
          <span>Images</span>
          <strong>{state.library.length.toLocaleString()}</strong>
          <small>Saved on this device</small>
        </div>
        <div>
          <span>Batches</span>
          <strong>{batches}</strong>
          <small>Grouped by your batch names</small>
        </div>
        <div>
          <span>Latest batch</span>
          <strong>{latestBatch}</strong>
          <small>Most recently added frames</small>
        </div>
      </div>

      <section className="panel library-panel" aria-label="Saved images">
        <header className="library-toolbar">
          <div className="segmented-control" role="group" aria-label="Library scope">
            <button
              type="button"
              className={scope === 'all' ? 'active' : ''}
              aria-pressed={scope === 'all'}
              onClick={() => setScope('all')}
            >
              All batches
            </button>
            <button
              type="button"
              className={scope === 'current' ? 'active' : ''}
              aria-pressed={scope === 'current'}
              onClick={() => setScope('current')}
            >
              Current batch
            </button>
          </div>
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <span className="visually-hidden">Search library</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search prompts or batch names…"
            />
            {query ? (
              <IconButton label="Clear search" icon={X} onClick={() => setQuery('')} />
            ) : null}
          </label>
          <span className="library-toolbar__count">
            {assets.length} {assets.length === 1 ? 'image' : 'images'}
          </span>
        </header>

        {assets.length ? (
          <>
            <div className="asset-grid">
              {assets.slice(0, visibleCount).map((asset) => {
                const label = frameLabel(asset);
                return (
                  <article className="asset-card" key={asset.id}>
                    <button
                      className="asset-card__open"
                      type="button"
                      aria-label={'Open details for ' + label}
                      onClick={() => setSelected(asset)}
                    >
                      <span className="asset-card__image">
                        <LibraryAssetImage asset={asset} adapter={adapter} />
                      </span>
                      <span className="asset-card__body">
                        <strong>{label}</strong>
                        {asset.recovered ? null : <em>{asset.prompt}</em>}
                      </span>
                    </button>
                    <div className="asset-card__footer">
                      <small>{asset.recovered ? 'Saved locally' : `${asset.durationSeconds.toFixed(1)}s render`}</small>
                      <Button
                        className="asset-card__download"
                        tone="quiet"
                        compact
                        icon={Download}
                        pending={downloadingId === asset.id}
                        disabled={downloadingId !== null}
                        aria-label={'Download ' + label}
                        onClick={() => void downloadAsset(asset)}
                      >
                        Download
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
            {assets.length > visibleCount ? (
              <div className="load-more">
                <Button onClick={() => setVisibleCount((count) => count + INITIAL_VISIBLE_ASSETS)}>
                  Show 36 more
                </Button>
                <span>
                  {Math.min(visibleCount, assets.length)} of {assets.length} shown
                </span>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState
            icon={Images}
            title={query ? 'No images match that search' : 'Your finished images will appear here'}
            copy={
              query
                ? 'Try a batch name or a word from the original prompt.'
                : 'Images appear as each completed frame is saved to your folder.'
            }
            action={
              query
                ? <Button onClick={() => setQuery('')}>Clear search</Button>
                : (
                  <Button
                    tone="primary"
                    onClick={() => dispatch({ type: 'NAVIGATE', view: 'create' })}
                  >
                    Open Create
                  </Button>
                )
            }
          />
        )}
      </section>

      {selected ? (
        <DialogPortal
          backdropClassName="asset-inspector-backdrop"
          surfaceClassName="asset-inspector"
          labelledBy="asset-title"
          describedBy={selected.recovered ? undefined : 'asset-description'}
          onRequestClose={() => setSelected(null)}
        >
          <IconButton
            data-autofocus
            className="asset-inspector__close"
            label="Close image details"
            icon={X}
            onClick={() => setSelected(null)}
          />
          <div className="asset-inspector__preview">
            <LibraryAssetImage asset={selected} adapter={adapter} large />
          </div>
          <div className="asset-inspector__content">
            <div>
              <Eyebrow>{selected.batchName}</Eyebrow>
              <h2 id="asset-title">{frameLabel(selected)}</h2>
            </div>
            {selected.recovered ? null : (
              <blockquote id="asset-description">“{selected.prompt}”</blockquote>
            )}
            <dl className={`asset-inspector__summary${selected.recovered ? ' asset-inspector__summary--single' : ''}`}>
              <div>
                <dt>Created</dt>
                <dd>{formattedDate(selected.createdAt)}</dd>
              </div>
              {selected.recovered ? null : (
                <div>
                  <dt>Render time</dt>
                  <dd>{selected.durationSeconds.toFixed(1)} seconds</dd>
                </div>
              )}
            </dl>
            <div className="asset-inspector__actions">
              <Button
                tone="primary"
                icon={Download}
                pending={downloadingId === selected.id}
                disabled={downloadingId !== null}
                aria-label={'Download ' + frameLabel(selected)}
                onClick={() => void downloadAsset(selected)}
              >
                Download
              </Button>
              <Button
                icon={FolderOpen}
                aria-label={'Show ' + frameLabel(selected) + ' in folder'}
                onClick={() => void showInFolder(selected)}
              >
                Show in folder
              </Button>
            </div>
          </div>
        </DialogPortal>
      ) : null}
    </div>
  );
}
