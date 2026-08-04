import { Activity, ArrowDownToLine, Clock3, Coins, Gauge, Leaf, ShieldCheck, Zap } from 'lucide-react';
import { batchCounts } from '../domain/reducer';
import { hasActivePodIdentity, type UsageRun } from '../domain/types';
import { Button, EmptyState, Eyebrow, PhaseBadge } from '../components/primitives';
import type { ScreenProps } from './types';

function exportUsage(runs: UsageRun[]) {
  const header = 'batch,date,gpu,completed,failed,elapsed_seconds,cost_usd';
  const rows = runs.map((run) => [
    `"${run.name.replaceAll('"', '""')}"`,
    run.date,
    run.gpu,
    run.completed,
    run.failed,
    run.seconds,
    run.cost.toFixed(4),
  ].join(','));
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'imageforge-usage.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function UsageScreen({ state, dispatch, adapter }: ScreenProps) {
  const currentCounts = batchCounts(state.batch);
  const currentRun: UsageRun | null = state.batch
    ? {
        id: `current-${state.batch.id}`,
        name: state.batch.name,
        date: state.batch.startedAt,
        gpu: state.pod.gpu ?? 'RTX 4090',
        completed: currentCounts.completed,
        failed: currentCounts.failed,
        seconds: state.batch.elapsedSeconds,
        cost: state.batch.estimatedCost,
      }
    : null;
  const persistedRuns = state.usage.filter((run) => run.id !== `usage-${state.batch?.id}`);
  const chartRuns = [...(currentRun ? [currentRun] : []), ...persistedRuns].slice(0, 7).reverse();
  const totals = chartRuns.reduce(
    (result, run) => ({ images: result.images + run.completed, seconds: result.seconds + run.seconds, cost: result.cost + run.cost, failed: result.failed + run.failed }),
    { images: 0, seconds: 0, cost: 0, failed: 0 },
  );
  const maxCost = Math.max(...chartRuns.map((run) => run.cost), 0.01);
  const avgSeconds = totals.images ? totals.seconds / totals.images : 0;
  const costPerImage = totals.images ? totals.cost / totals.images : 0;
  const podHasIdentity = hasActivePodIdentity(state.pod);
  const podStatus = state.pod.phase === 'ready'
    ? 'Ready'
    : state.pod.phase === 'error'
      ? 'Needs attention'
      : state.pod.phase === 'stopping'
        ? 'Stopping'
        : podHasIdentity
          ? 'Active · checking'
          : 'Offline';

  return (
    <div className="screen usage-screen">
      <section className="page-heading">
        <div><Eyebrow>Usage</Eyebrow><h1>Usage and cost</h1><p>Recent batches, image counts, and measured GPU cost.</p></div>
        <div className="page-heading__actions">
          <Button icon={ArrowDownToLine} disabled={!chartRuns.length} onClick={() => exportUsage(chartRuns)}>Export usage CSV</Button>
          <PhaseBadge tone={state.pod.phase === 'ready' ? 'success' : state.pod.phase === 'error' ? 'danger' : podHasIdentity ? 'warning' : 'neutral'}>{state.pod.gpu ? `${state.pod.gpu} · $${state.pod.hourlyRate?.toFixed(2)}/hr` : 'compute offline'}</PhaseBadge>
        </div>
      </section>

      <div className="usage-kpis">
        <article><span className="usage-kpi__icon"><Coins size={19} /></span><div><small>Total cost</small><strong>${totals.cost.toFixed(3)}</strong><em>across {chartRuns.length} recent batches</em></div></article>
        <article><span className="usage-kpi__icon"><Gauge size={19} /></span><div><small>Cost per image</small><strong>${costPerImage.toFixed(4)}</strong><em>completed images only</em></div></article>
        <article><span className="usage-kpi__icon"><Clock3 size={19} /></span><div><small>Average time per image</small><strong>{avgSeconds.toFixed(1)}s</strong><em>selected size · four steps</em></div></article>
        <article><span className="usage-kpi__icon"><ShieldCheck size={19} /></span><div><small>Images created</small><strong>{totals.images}</strong><em>{totals.failed} failed</em></div></article>
      </div>

      {chartRuns.length ? (
        <div className="usage-layout">
          <section className="panel usage-chart-panel">
            <header className="panel-heading"><div><Eyebrow>Recent batches</Eyebrow><h2>Cost by batch</h2></div><span className="source-chip"><Activity size={14} /> {adapter.mode === 'production' ? 'Live data' : 'Test data'}</span></header>
            <div className="cost-chart" role="img" aria-label="Cost by recent production batch">
              <div className="cost-chart__scale"><span>${maxCost.toFixed(2)}</span><span>${(maxCost / 2).toFixed(2)}</span><span>$0</span></div>
              <div className="cost-chart__bars">
                {chartRuns.map((run, index) => (
                  <div className="cost-bar" key={run.id}>
                    <span className="cost-bar__value">${run.cost.toFixed(3)}</span>
                    <div className="cost-bar__track"><i style={{ height: `${Math.max(8, (run.cost / maxCost) * 100)}%` }} /></div>
                    <small>{index === chartRuns.length - 1 && currentRun ? 'Now' : run.name.split(' ')[0]}</small>
                  </div>
                ))}
              </div>
            </div>
            <footer className="chart-note"><Leaf size={16} /><span>ImageForge checks approved GPUs for value only after you click Start GPU. It never starts compute automatically.</span></footer>
          </section>

          <aside className="panel live-cost-panel">
            <header className="panel-heading panel-heading--compact"><div><Eyebrow>GPU cost</Eyebrow><h2>{state.pod.gpu ?? 'GPU offline'}</h2></div><Zap size={20} /></header>
            {state.pod.gpu ? (
              <>
                <div className="live-rate"><span>Live hourly rate</span><strong>${state.pod.hourlyRate?.toFixed(2)}</strong><small>per GPU hour · one GPU</small></div>
                <dl className="live-cost-details">
                  <div><dt>Status</dt><dd>{podStatus}</dd></div>
                  <div><dt>Storage</dt><dd>Persistent volume</dd></div>
                  <div><dt>Shutdown</dt><dd>Manual only</dd></div>
                </dl>
                <div className="manual-stop-note"><ShieldCheck size={16} /><span>Completion, idle time, app exit, and connection loss cannot terminate this Pod.</span></div>
                <Button tone="danger" onClick={() => dispatch({ type: 'REQUEST_STOP_POD' })}>Stop GPU explicitly</Button>
              </>
            ) : (
              <EmptyState icon={Zap} title="No hourly compute cost" copy="A GPU starts only after a foreground click." />
            )}
          </aside>
        </div>
      ) : (
        <section className="panel"><EmptyState icon={Activity} title="No usage yet" copy={adapter.mode === 'production' ? 'Complete a batch to see timing and cost history.' : 'Run a simulated batch to see timing and cost history.'} action={<Button tone="primary" onClick={() => dispatch({ type: 'NAVIGATE', view: 'create' })}>Open Create</Button>} /></section>
      )}

      <section className="panel usage-table-panel">
        <header className="panel-heading"><div><Eyebrow>History</Eyebrow><h2>Recent batches</h2></div><span>{chartRuns.length} records</span></header>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead><tr><th>Batch</th><th>GPU</th><th>Images</th><th>Failed</th><th>Elapsed</th><th>Cost</th><th>Cost / image</th></tr></thead>
            <tbody>
              {chartRuns.slice().reverse().map((run, index) => (
                <tr key={run.id}>
                  <td><strong>{run.name}</strong><small>{formatDate(run.date)}{index === 0 && currentRun ? ' · live' : ''}</small></td>
                  <td><span className="table-gpu"><i />{run.gpu}</span></td>
                  <td>{run.completed}</td><td className={run.failed ? 'warning-text' : ''}>{run.failed}</td>
                  <td>{Math.round(run.seconds / 60)}m {Math.round(run.seconds % 60)}s</td><td>${run.cost.toFixed(3)}</td>
                  <td>${run.completed ? (run.cost / run.completed).toFixed(4) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
