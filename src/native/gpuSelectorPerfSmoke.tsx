import { LogicalSize } from '@tauri-apps/api/dpi';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  GpuSelectorOfferV1,
  NativeGpuInventorySnapshotV1,
} from '@imageforge/runpod-client';
import { GpuSelector } from '../components/GpuSelector';
import {
  nativeGpuSelectorPerfArm,
  nativeGpuSelectorPerfCommit,
  type GpuSelectorPerfActionV1,
  type GpuSelectorPerfStartedEventV1,
} from './tauriBridge';
import {
  advanceWarmOpen,
  isMeasuredInputReady,
  type SelectorPerfArmState,
} from './gpuSelectorPerfSmokeState';

const FIXTURE_SHA256 = '102cfe7267c269a1344d3758ef1deea4cfbe5d469d2de9b996f5c06499eacf68';
const ROW_IDS = [
  'current',
  'auto',
  'ordinary:rtx-4090',
  'ordinary:rtx-pro-4500-blackwell',
  'ordinary:rtx-5090',
  'ordinary:rtx-pro-4000-blackwell',
  'ordinary:l4',
  'ordinary:rtx-a4500',
  'ordinary:rtx-4000-ada',
  'emergency:rtx-2000-ada',
] as const;
const OBSERVATION_ID = '11111111-1111-4111-8111-111111111111';
const RECEIPT_ID = '22222222-2222-4222-8222-222222222222';
const PROCESS_EPOCH_ID = '33333333-3333-4333-8333-333333333333';
const OBSERVED_AT = '2026-08-04T00:00:00.000Z';

const OFFER_DEFINITIONS = [
  ['NVIDIA GeForce RTX 4090', 'rtx_4090', 'RTX 4090', 24, false],
  ['NVIDIA RTX PRO 4500 Blackwell', 'rtx_pro_4500_blackwell', 'RTX PRO 4500 Blackwell', 32, false],
  ['NVIDIA GeForce RTX 5090', 'rtx_5090', 'RTX 5090', 32, false],
  ['NVIDIA RTX PRO 4000 Blackwell', 'rtx_pro_4000_blackwell', 'RTX PRO 4000 Blackwell', 24, false],
  ['NVIDIA L4', 'l4', 'L4', 24, false],
  ['NVIDIA RTX A4500', 'rtx_a4500', 'RTX A4500', 20, false],
  ['NVIDIA RTX 4000 Ada Generation', 'rtx_4000_ada', 'RTX 4000 Ada', 20, false],
  ['NVIDIA RTX 2000 Ada Generation', 'rtx_2000_ada', 'RTX 2000 Ada', 16, true],
] as const;

function offer(
  [gpuId, policyKey, displayName, memoryGb, emergency]: (typeof OFFER_DEFINITIONS)[number],
  index: number,
): GpuSelectorOfferV1 {
  return {
    schemaVersion: 1,
    observationId: OBSERVATION_ID,
    receiptId: RECEIPT_ID,
    gpuId,
    policyKey,
    displayName,
    memoryGb,
    emergency,
    availability: 'high',
    hourlyPriceMicroUsd: 400_000 + index * 50_000,
    dataCenterId: 'EU-RO-1',
    source: 'live',
    observedAt: OBSERVED_AT,
    stale: false,
    selectable: true,
    disabledReason: null,
    benchmarkState: 'unmeasured',
    benchmarkAgeMs: null,
    speedScore: null,
    benchmarkMedianDurationUs: null,
    benchmarkP95DurationUs: null,
    benchmarkMeasuredAt: null,
    benchmarkEvidenceSha256: null,
    estimatedSwitchRemainingCostMicroUsd: null,
  };
}

function fixtureSnapshot(state: NativeGpuInventorySnapshotV1['state'] = 'ready'): NativeGpuInventorySnapshotV1 {
  const ready = state === 'ready';
  return {
    schemaVersion: 1,
    observationId: OBSERVATION_ID,
    processEpochId: PROCESS_EPOCH_ID,
    includeEmergencyTier: true,
    state,
    observedAt: ready ? OBSERVED_AT : null,
    receipt: ready ? {
      schemaVersion: 1,
      receiptId: RECEIPT_ID,
      processEpochId: PROCESS_EPOCH_ID,
      receivedAt: OBSERVED_AT,
      validForMs: 60000,
      catalogSha256: 'a'.repeat(64),
    } : null,
    // Keep the deterministic 10-row mount stable while the state label moves
    // to loading; the timing gate measures input-to-first painted loading
    // semantics, not provider response completion.
    offers: OFFER_DEFINITIONS.map((entry, index) => offer(entry, index)),
    currentPod: {
      podId: 'selector-perf-pod',
      gpuId: 'NVIDIA RTX 3080',
      gpuDisplayName: 'RTX 3080',
      hourlyPriceMicroUsd: 300_000,
    },
    currentPodObservedAt: OBSERVED_AT,
    currentPodStale: false,
    issue: null,
  };
}

function rowsFromDom(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-gpu-row-id]'))
    .map((row) => row.dataset.gpuRowId ?? '');
}

function exactStartedEvent(value: unknown): GpuSelectorPerfStartedEventV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Selector performance native event is not an object.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['action', 'event', 'ordinal', 'qaSessionId', 'sampleId', 'schemaVersion', 'viewportHeight', 'viewportWidth'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Selector performance native event has unexpected fields.');
  }
  if (
    record.schemaVersion !== 1
    || record.event !== 'gpu-selector-perf-started-v1'
    || typeof record.qaSessionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.qaSessionId)
    || typeof record.sampleId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.sampleId)
    || typeof record.action !== 'string'
    || !Number.isSafeInteger(record.ordinal)
    || !Number.isSafeInteger(record.viewportWidth)
    || !Number.isSafeInteger(record.viewportHeight)
  ) {
    throw new Error('Selector performance native event is invalid.');
  }
  return record as unknown as GpuSelectorPerfStartedEventV1;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

function errorDetail(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  if (typeof reason === 'object' && reason !== null) {
    const record = reason as Record<string, unknown>;
    if (typeof record.message === 'string') {
      return typeof record.code === 'string'
        ? `${record.code}: ${record.message}`
        : record.message;
    }
    try {
      return JSON.stringify(reason);
    } catch {
      return 'The native selector performance operation returned an unreadable error.';
    }
  }
  return String(reason);
}

async function waitForExactViewport(
  width: number,
  height: number,
  timeoutMs = 10_000,
): Promise<{ width: number; height: number }> {
  const deadline = Date.now() + timeoutMs;
  let measured = { width: window.innerWidth, height: window.innerHeight };
  while (Date.now() < deadline) {
    measured = { width: window.innerWidth, height: window.innerHeight };
    if (Math.abs(measured.width - width) <= 1 && Math.abs(measured.height - height) <= 1) {
      return measured;
    }
    await nextPaint();
  }
  throw new Error(
    `The selector performance window did not reach ${width}x${height}; measured ${measured.width}x${measured.height}.`,
  );
}

async function setExactViewport(
  appWindow: ReturnType<typeof getCurrentWindow>,
  width: number,
  height: number,
): Promise<void> {
  await appWindow.setSize(new LogicalSize(width, height));
  try {
    await waitForExactViewport(width, height);
    return;
  } catch (initialError) {
    // Some native titlebar configurations report a small logical inner-frame
    // offset. Derive only that observed native-to-CSS delta, then require the
    // DOM viewport to reach the exact requested size again.
    const [inner, nativeScale] = await Promise.all([
      appWindow.innerSize(),
      appWindow.scaleFactor(),
    ]);
    const scale = Number.isFinite(nativeScale) && nativeScale > 0 ? nativeScale : 1;
    const nativeLogical = inner.toLogical(scale);
    const contentOffsetWidth = Math.round(nativeLogical.width - window.innerWidth);
    const contentOffsetHeight = Math.round(nativeLogical.height - window.innerHeight);
    const adjustedWidth = contentOffsetWidth > 0 && contentOffsetWidth < 200
      ? width + contentOffsetWidth
      : width;
    const adjustedHeight = contentOffsetHeight > 0 && contentOffsetHeight < 200
      ? height + contentOffsetHeight
      : height;
    if (adjustedWidth === width && adjustedHeight === height) throw initialError;
    await appWindow.setSize(new LogicalSize(adjustedWidth, adjustedHeight));
    await waitForExactViewport(width, height);
  }
}

async function report(passed: boolean, detail: string): Promise<void> {
  await invoke('native_smoke_result', { passed, detail: detail.slice(0, 240) });
}

export function GpuSelectorPerfSmoke() {
  const config = window.__IMAGEFORGE_GPU_SELECTOR_PERF_QA_CONFIG__;
  if (config === undefined) {
    throw new Error('The installed selector performance QA configuration is missing.');
  }
  const initialOpen = config.action !== 'cold_open';
  const [open, setOpen] = useState(initialOpen);
  const [snapshot, setSnapshot] = useState(() => fixtureSnapshot());
  const [cycle, setCycle] = useState(0);
  const [warmupsRemaining, setWarmupsRemaining] = useState(config.action === 'warm_open' ? 3 : 0);
  const [armState, setArmState] = useState<SelectorPerfArmState>('idle');
  const [error, setError] = useState<string | null>(null);
  const openRef = useRef(open);
  const snapshotRef = useRef(snapshot);
  const warmupsRef = useRef(warmupsRemaining);
  const ordinalRef = useRef(1);
  const armedRef = useRef(false);
  const armingRef = useRef(false);
  const armProbeDoneRef = useRef(false);
  const pendingRef = useRef<GpuSelectorPerfStartedEventV1 | null>(null);
  const reportedRef = useRef(false);
  const sizeReadyRef = useRef(false);
  const listenerReadyRef = useRef(false);
  const nativeWindowReadyRef = useRef(false);
  const mountedRef = useRef(true);
  const action = config.action;
  const maxSamples = action === 'cold_open' ? 1 : 30;
  const readySnapshot = useMemo(() => fixtureSnapshot('ready'), []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    warmupsRef.current = warmupsRemaining;
  }, [warmupsRemaining]);

  const fail = (reason: unknown) => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    const detail = errorDetail(reason);
    setError(detail);
    void report(false, detail).catch(() => undefined);
  };

  useEffect(() => {
    mountedRef.current = true;
    setArmState('idle');
    sizeReadyRef.current = false;
    listenerReadyRef.current = false;
    nativeWindowReadyRef.current = false;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const markReady = () => {
      if (!listenerReadyRef.current || !nativeWindowReadyRef.current || disposed) return;
      sizeReadyRef.current = true;
      if (mountedRef.current) setCycle((value) => value + 1);
    };

    const handleStarted = async (payload: unknown) => {
      try {
        const started = exactStartedEvent(payload);
        if (reportedRef.current || pendingRef.current !== null) return;
        if (
          started.action !== action
          || started.ordinal !== ordinalRef.current
          || started.viewportWidth !== config.viewportWidth
          || started.viewportHeight !== config.viewportHeight
        ) {
          throw new Error('Selector performance native event did not match the current arm.');
        }
        armedRef.current = false;
        setArmState('idle');
        pendingRef.current = started;
        await nextPaint();
        const deadline = Date.now() + 2_000;
        let mounted = rowsFromDom();
        while (
          mounted.length !== ROW_IDS.length
          || mounted.some((rowId, index) => rowId !== ROW_IDS[index])
          || (action === 'refresh_loading' && document.querySelector('[data-gpu-selector-state="loading"]') === null)
          || (action !== 'refresh_loading' && document.querySelector('[data-gpu-selector-state="ready"]') === null)
        ) {
          if (Date.now() >= deadline) throw new Error('Selector performance observable state did not paint.');
          await nextPaint();
          mounted = rowsFromDom();
        }
        const commitInput = {
          qaSessionId: started.qaSessionId,
          sampleId: started.sampleId,
          mountedRowIds: mounted,
        } as const;
        try {
          await nativeGpuSelectorPerfCommit({
            ...commitInput,
            mountedRowIds: [...mounted].reverse(),
          });
          throw new Error('The selector performance bridge accepted a forged row order.');
        } catch (caught) {
          if (caught instanceof Error && caught.message.includes('accepted a forged')) throw caught;
        }
        const tamperedSampleId = `${started.sampleId.slice(0, -1)}${started.sampleId.endsWith('0') ? '1' : '0'}`;
        try {
          await nativeGpuSelectorPerfCommit({ ...commitInput, sampleId: tamperedSampleId });
          throw new Error('The selector performance bridge accepted a forged sample ID.');
        } catch (caught) {
          if (caught instanceof Error && caught.message.includes('accepted a forged')) throw caught;
        }
        const sample = await nativeGpuSelectorPerfCommit(commitInput);
        console.info('IMAGEFORGE_GPU_SELECTOR_PERF_SAMPLE_V1', JSON.stringify(sample));
        try {
          await nativeGpuSelectorPerfCommit(commitInput);
          throw new Error('The selector performance bridge accepted a replayed sample.');
        } catch (caught) {
          if (caught instanceof Error && caught.message.includes('accepted a replayed')) throw caught;
        }
        pendingRef.current = null;
        if (ordinalRef.current >= maxSamples) {
          reportedRef.current = true;
          await report(true, `${action} ${maxSamples} samples passed at ${config.viewportWidth}x${config.viewportHeight}`);
          return;
        }
        ordinalRef.current += 1;
        if (action === 'warm_open') {
          setOpen(false);
        } else if (action === 'refresh_loading') {
          setSnapshot(readySnapshot);
        }
        setCycle((value) => value + 1);
      } catch (caught) {
        pendingRef.current = null;
        fail(caught);
      }
    };

    void Promise.all([
      listen<unknown>('gpu-selector-perf-started-v1', (event) => {
        void handleStarted(event.payload);
      }),
      listen<unknown>('gpu-selector-perf-error-v1', (event) => {
        fail(event.payload);
      }),
    ]).then(([removeStarted, removeError]) => {
      if (disposed) {
        removeStarted();
        removeError();
      } else {
        unlisten = () => {
          removeStarted();
          removeError();
        };
        listenerReadyRef.current = true;
        markReady();
      }
    }).catch(fail);

    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        await setExactViewport(appWindow, config.viewportWidth, config.viewportHeight);
        await appWindow.setFocus();
        nativeWindowReadyRef.current = true;
        markReady();
      } catch (caught) {
        fail(caught);
      }
    })();

    return () => {
      disposed = true;
      mountedRef.current = false;
      unlisten?.();
    };
  }, [action, config, maxSamples, readySnapshot]);

  useEffect(() => {
    if (!sizeReadyRef.current || reportedRef.current || armedRef.current || armingRef.current || pendingRef.current !== null) return;
    // Use the committed render state for the warm-up gate. The refs are
    // useful inside native-event callbacks, but an arm request must observe
    // the same state transition that just closed the sheet; relying on a ref
    // updated by a separate effect can miss the first measured arm after the
    // final warm-up click.
    if (action === 'warm_open' && (warmupsRemaining > 0 || open)) return;
    if (action !== 'cold_open' && action !== 'warm_open' && !openRef.current) return;
    const armInput = {
      fixtureSha256: FIXTURE_SHA256,
      action,
      ordinal: ordinalRef.current,
      viewportWidth: config.viewportWidth,
      viewportHeight: config.viewportHeight,
    } as const;
    armingRef.current = true;
    setArmState('arming');
    void (async () => {
      try {
        if (!armProbeDoneRef.current) {
          armProbeDoneRef.current = true;
          try {
            await nativeGpuSelectorPerfArm({ ...armInput, fixtureSha256: '0'.repeat(64) });
            throw new Error('The selector performance bridge accepted a forged fixture hash.');
          } catch (caught) {
            if (caught instanceof Error && caught.message.includes('accepted a forged')) throw caught;
          }
        }
        await nativeGpuSelectorPerfArm(armInput);
        armedRef.current = true;
        if (mountedRef.current) setArmState('armed');
      } catch (caught) {
        fail(caught);
      } finally {
        armingRef.current = false;
      }
    })();
  }, [action, config, cycle, maxSamples, open, warmupsRemaining]);

  const measuredInputReady = isMeasuredInputReady(warmupsRemaining, armState);

  if (error !== null) {
    return <main data-gpu-selector-perf-qa="failed">{error}</main>;
  }

  return (
    <main data-gpu-selector-perf-qa="v1" style={{ width: '100%', minWidth: 0 }}>
      {open ? (
        <>
          <GpuSelector
            snapshot={snapshot}
            mode="offline_start"
            onClose={() => setOpen(false)}
            onRefresh={() => setSnapshot(fixtureSnapshot('loading'))}
            onCommit={() => fail(new Error('The selector performance harness must not commit a provider action.'))}
            busy={false}
          />
          {action === 'warm_open' ? (
            <button
              type="button"
              data-gpu-selector-perf-close="true"
              onClick={() => setOpen(false)}
              style={{ position: 'fixed', top: 8, right: 8, zIndex: 20 }}
            >
              Close QA sheet
            </button>
          ) : null}
          {action === 'refresh_loading' ? (
            <button
              type="button"
              data-gpu-selector-perf-refresh="true"
              aria-busy={!measuredInputReady}
              onClick={() => {
                setArmState('idle');
                setSnapshot(fixtureSnapshot('loading'));
              }}
              style={{ position: 'fixed', top: 8, left: 8, zIndex: 20 }}
            >
              Refresh GPUs
            </button>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          data-gpu-selector-perf-open="true"
          aria-busy={warmupsRemaining === 0 && armState !== 'armed'}
          onClick={() => {
            if (action === 'warm_open' && warmupsRemaining > 0) {
              const next = advanceWarmOpen(warmupsRemaining);
              setWarmupsRemaining(next.warmupsRemaining);
              setArmState('idle');
              // Leave the sheet closed after the last unrecorded warm-up so
              // the native arm effect has one unambiguous closed state before
              // the first measured open.
              setOpen(next.open);
              return;
            }
            setArmState('idle');
            setOpen(true);
          }}
          style={{ width: '100vw', height: '100vh' }}
        >
          Open GPU selector
        </button>
      )}
    </main>
  );
}
