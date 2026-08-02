import { AlertTriangle, Check, Download, LoaderCircle, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BatchPrompt } from '../domain/types';

const ROW_HEIGHT = 68;

function statusLabel(prompt: BatchPrompt) {
  switch (prompt.status) {
    case 'downloaded':
      return 'Downloaded';
    case 'generating':
      return 'Generating';
    case 'retrying':
      return 'Retrying';
    case 'ready':
      return 'Ready';
    case 'downloading':
      return 'Downloading';
    case 'failed':
      return 'Needs retry';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Waiting';
  }
}

function RowStatus({ prompt }: { prompt: BatchPrompt }) {
  if (prompt.status === 'downloaded') return <Check size={15} aria-hidden="true" />;
  if (prompt.status === 'generating') return <LoaderCircle className="spin" size={15} aria-hidden="true" />;
  if (prompt.status === 'retrying') return <RotateCw className="spin" size={15} aria-hidden="true" />;
  if (prompt.status === 'downloading' || prompt.status === 'ready') return <Download size={15} aria-hidden="true" />;
  if (prompt.status === 'failed' || prompt.status === 'cancelled') return <AlertTriangle size={15} aria-hidden="true" />;
  return <span className="prompt-row__pending-dot" aria-hidden="true" />;
}

export function VirtualPromptList({
  prompts,
  selectedId,
  onSelect,
}: {
  prompts: BatchPrompt[];
  selectedId?: string;
  onSelect: (prompt: BatchPrompt) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(430);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setViewportHeight(element.clientHeight || 430);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const range = useMemo(() => {
    const overscan = 4;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
    const visible = Math.ceil(viewportHeight / ROW_HEIGHT) + overscan * 2;
    return { start, end: Math.min(prompts.length, start + visible) };
  }, [prompts.length, scrollTop, viewportHeight]);

  return (
    <div
      className="virtual-list"
      ref={containerRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      aria-label={`${prompts.length} ordered prompts`}
    >
      <div className="virtual-list__spacer" style={{ height: prompts.length * ROW_HEIGHT }}>
        {prompts.slice(range.start, range.end).map((prompt, localIndex) => {
          const absoluteIndex = range.start + localIndex;
          return (
            <button
              type="button"
              className={`prompt-row prompt-row--${prompt.status} ${selectedId === prompt.id ? 'prompt-row--selected' : ''}`}
              style={{ transform: `translateY(${absoluteIndex * ROW_HEIGHT}px)` }}
              key={prompt.id}
              onClick={() => onSelect(prompt)}
              aria-current={selectedId === prompt.id || undefined}
            >
              <span className="prompt-row__rail"><RowStatus prompt={prompt} /></span>
              <span className="prompt-row__index">{String(prompt.index).padStart(3, '0')}</span>
              <span className="prompt-row__copy">
                <strong>{prompt.text}</strong>
                <small>{prompt.durationSeconds ? `${prompt.durationSeconds.toFixed(1)}s` : 'Waiting for timing'}</small>
              </span>
              <span className="prompt-row__status">{statusLabel(prompt)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
