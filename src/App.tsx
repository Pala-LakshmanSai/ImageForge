import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { formatHourlyMicroUsdV1, type NativeGpuInventorySnapshotV1 } from '@imageforge/runpod-client';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createFakeImageForgeAdapter, type ImageForgeAdapter } from './adapters/imageForgeAdapter';
import { WebAudioQueueAlarm, type QueueAlarmPort } from './adapters/queueAlarm';
import { snapshotQueueReferences } from './adapters/queueStore';
import {
  persistSafePreferences,
  readPersistedBatchRecovery,
  type PersistedBatchRecovery,
} from './adapters/safePreferences';
import { BottomNav, TopBar } from './components/AppChrome';
import { DialogPortal } from './components/DialogPortal';
import { GpuSelector } from './components/GpuSelector';
import { GpuSwitchConsent } from './components/GpuSwitchConsent';
import {
  GpuSwitchProgress,
  type GpuSwitchProgressActionV1,
} from './components/GpuSwitchProgress';
import { SetupAssistant } from './components/SetupAssistant';
import { StudioCoordination } from './components/StudioCoordination';
import { Button, IconButton } from './components/primitives';
import { canStartBatch, createInitialState, appReducer } from './domain/reducer';
import {
  assertQueueItemTransition,
  clearQueueHistory,
  createQueueRun,
  createStagedQueueItem,
  isCanonicalQueueUuid,
  isQueuePlaceholder,
  isQueueLocallyRemovableIssue,
  moveQueueItem,
  nextQueueItem,
  queueCohortAtFixedPoint,
  queueCompletionKind,
  queueRunIsActive,
  removeQueueItem,
  replaceQueueItem,
  updateQueueItem,
  updateQueueRun,
  type NativeQueueAlarmV1,
  type NativeQueueDocumentV1,
  type NativeQueueSnapshotV1,
  type QueueAlertKind,
} from './domain/queue';
import type { AppAction, AppState } from './domain/types';
import type { GpuSelectorConfirmationV1, GpuSelectorModeV1 } from './domain/gpuSelector';
import type { NativeGpuStartResultV1 } from './native/gpuStartBridge';
import type { NativeGpuSwitchSnapshotV1 } from './native/gpuSwitchBridge';
import { asNativeError } from './native/tauriBridge';
import { userFacingErrorMessage } from './native/userFacingError';
import { CreateScreen } from './screens/CreateScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { ProgressScreen } from './screens/ProgressScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { UsageScreen } from './screens/UsageScreen';
import './styles.css';

export interface AppProps {
  initialState?: AppState;
  adapter?: ImageForgeAdapter;
  alarmPort?: QueueAlarmPort;
}

const CROSS_CLIENT_HEARTBEAT_MS = 4_000;
const GPU_SELECTOR_LOAD_TIMEOUT_MS = 15_000;
// The native receipt authorizes a paid Start for `validForMs` (60s). Re-observe
// with this much of that window left so an open selector keeps a live receipt
// instead of failing the confirmed click with `gpu_start_inventory_stale`.
const GPU_SELECTOR_RECEIPT_REFRESH_LEAD_MS = 15_000;
// Native rejections that only mean "this receipt no longer speaks for live
// inventory". The sheet stays mounted, so re-observe instead of leaving rows
// that are guaranteed to fail again.
const GPU_START_INVENTORY_RECOVERY_CODES: ReadonlySet<string> = new Set([
  'gpu_start_inventory_stale',
  'gpu_start_inventory_receipt_invalid',
  'gpu_start_target_changed',
  'gpu_start_price_changed',
  'gpu_start_revision_conflict',
]);

export default function App({ initialState, adapter: injectedAdapter, alarmPort: injectedAlarm }: AppProps) {
  const [state, dispatch] = useReducer(appReducer, initialState, (provided) => provided ?? createInitialState());
  const adapter = useMemo(
    () => injectedAdapter ?? createFakeImageForgeAdapter(initialState?.setup.credentials),
    [injectedAdapter, initialState?.setup.credentials],
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const runtime = adapter.mode === 'production' ? adapter.runtime : undefined;
  const [gpuSelectorOpen, setGpuSelectorOpen] = useState(false);
  const [gpuSelectorBusy, setGpuSelectorBusy] = useState(false);
  const [gpuSelectorMode, setGpuSelectorMode] = useState<GpuSelectorModeV1>('offline_start');
  const [gpuSelectorSnapshot, setGpuSelectorSnapshot] = useState<NativeGpuInventorySnapshotV1 | null>(
    () => runtime?.getGpuInventory() ?? null,
  );
  const [gpuSelectorError, setGpuSelectorError] = useState<{
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null>(null);
  const [gpuSelectorConfirming, setGpuSelectorConfirming] = useState(false);
  const gpuSelectorReturnFocusRef = useRef<HTMLElement | null>(null);
  const gpuSelectorRequestRef = useRef(0);
  const [gpuPriceAttention, setGpuPriceAttention] = useState<NativeGpuStartResultV1 | null>(null);
  const [gpuPriceConfirmBusy, setGpuPriceConfirmBusy] = useState(false);
  const [gpuSwitchSnapshot, setGpuSwitchSnapshot] = useState<NativeGpuSwitchSnapshotV1 | null>(null);
  const [gpuSwitchLoadState, setGpuSwitchLoadState] = useState<'loading' | 'ready' | 'error'>(
    runtime ? 'loading' : 'ready',
  );
  const [gpuSwitchActionBusy, setGpuSwitchActionBusy] = useState<GpuSwitchProgressActionV1 | null>(null);
  const closeGpuSelector = useCallback(() => {
    gpuSelectorRequestRef.current += 1;
    setGpuSelectorOpen(false);
    setGpuSelectorBusy(false);
    setGpuSelectorConfirming(false);
    setGpuSelectorError(null);
  }, []);
  const alarm = useMemo(() => injectedAlarm ?? new WebAudioQueueAlarm(), [injectedAlarm]);
  const recoveryPointerRef = useRef<PersistedBatchRecovery | null>(
    adapter.mode === 'production' ? readPersistedBatchRecovery(window.localStorage) : null,
  );
  const clearRecoveryPointerRef = useRef(false);
  const refreshInFlightRef = useRef<Promise<boolean> | null>(null);
  const observationInFlightRef = useRef<Promise<void> | null>(null);
  // A foreground Start must not race the receipt-free Pod heartbeat for the
  // cross-process profile lease. Set this synchronously from the confirmed
  // click, drain any observation already holding the lease, and suppress new
  // advisory reads until the native Start command (including its OS modal)
  // settles.
  const gpuStartInFlightRef = useRef(false);
  const batchStartInFlightRef = useRef(false);
  const [batchStartPending, setBatchStartPending] = useState(false);
  const queueSnapshotRef = useRef<NativeQueueSnapshotV1>({
    schemaVersion: state.queue.schemaVersion,
    storeRevision: state.queue.storeRevision,
    document: state.queue.document,
    issues: state.queue.issues,
  });
  const queueMutationTailRef = useRef<Promise<void>>(Promise.resolve());
  const queueDispatchInFlightRef = useRef(false);
  const queueBatchSyncInFlightRef = useRef(false);
  const queueCompletionInFlightRef = useRef(false);
  const queueAlertInFlightRef = useRef(false);
  const queueAlertAttemptsRef = useRef(new Set<string>());
  const queueFailureCodesRef = useRef(new Map<string, string>());
  const queueAuthorizationRef = useRef<string | null>(null);
  const queuePodIdRef = useRef<string | null>(null);
  const queueRemoteCreateInFlightRef = useRef<string | null>(null);

  const commitQueue = useCallback((
    mutate: (document: NativeQueueDocumentV1) => NativeQueueDocumentV1,
    referenceBlobs: Parameters<ImageForgeAdapter['queue']['commit']>[0]['referenceBlobs'] = [],
  ): Promise<NativeQueueSnapshotV1> => {
    let resolveResult: (snapshot: NativeQueueSnapshotV1) => void;
    let rejectResult: (error: unknown) => void;
    const result = new Promise<NativeQueueSnapshotV1>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const operation = queueMutationTailRef.current.then(async () => {
      const current = queueSnapshotRef.current;
      const snapshot = await adapter.queue.commit({
        expectedRevision: current.storeRevision,
        document: mutate(current.document),
        referenceBlobs,
      });
      queueSnapshotRef.current = snapshot;
      dispatch({ type: 'QUEUE_COMMITTED', snapshot });
      resolveResult(snapshot);
    }).catch((error: unknown) => {
      rejectResult(error);
    });
    queueMutationTailRef.current = operation.then(() => undefined, () => undefined);
    return result;
  }, [adapter.queue]);

  const deliverQueueNotification = useCallback(async (
    alarmState: NativeQueueAlarmV1,
    forceRetry = false,
  ) => {
    if (alarmState.state !== 'ringing') return;
    const snoozeAttempt = alarmState.snoozeUsed && alarmState.snoozeNotificationDisposition !== null;
    const kind: QueueAlertKind | null = snoozeAttempt ? 'snooze' : alarmState.kind;
    const disposition = snoozeAttempt
      ? alarmState.snoozeNotificationDisposition
      : alarmState.notificationDisposition;
    if (kind === null || disposition === null || disposition === 'delivered') return;
    if (!forceRetry && !['pending', 'failed'].includes(disposition)) return;
    const attemptKey = `${alarmState.eventId}:${kind}`;
    if (!forceRetry && queueAlertAttemptsRef.current.has(attemptKey)) return;
    if (queueAlertInFlightRef.current) return;
    queueAlertAttemptsRef.current.add(attemptKey);
    queueAlertInFlightRef.current = true;
    try {
      const result = await adapter.queue.signalAlert({ eventId: alarmState.eventId, kind });
      const nextDisposition = result.disposition === 'delivered' || result.disposition === 'already_delivered'
        ? 'delivered'
        : result.disposition;
      await commitQueue((document) => {
        if (document.alarm?.eventId !== result.eventId) return document;
        return {
          ...document,
          alarm: snoozeAttempt
            ? { ...document.alarm, snoozeNotificationDisposition: nextDisposition }
            : { ...document.alarm, notificationDisposition: nextDisposition },
        };
      });
    } catch {
      await commitQueue((document) => {
        if (document.alarm?.eventId !== alarmState.eventId) return document;
        return {
          ...document,
          alarm: snoozeAttempt
            ? { ...document.alarm, snoozeNotificationDisposition: 'failed' }
            : { ...document.alarm, notificationDisposition: 'failed' },
        };
      }).catch(() => undefined);
    } finally {
      queueAlertInFlightRef.current = false;
    }
  }, [adapter.queue, commitQueue]);

  const releaseQueueResources = useCallback(async (runRevision: string) => {
    try {
      const power = await adapter.queue.setSleepPrevention({ runRevision, enabled: false });
      dispatch({ type: 'QUEUE_POWER_CHANGED', power });
    } catch {
      dispatch({ type: 'QUEUE_POWER_CHANGED', power: null });
    }
    try {
      const lease = await adapter.queue.releaseRunner({ runRevision });
      dispatch({ type: 'QUEUE_LEASE_CHANGED', lease });
    } catch {
      dispatch({ type: 'QUEUE_LEASE_CHANGED', lease: null });
    }
    if (queueAuthorizationRef.current === runRevision) queueAuthorizationRef.current = null;
  }, [adapter.queue]);

  const parkQueue = useCallback(async (code: string, message?: string) => {
    const current = queueSnapshotRef.current.document;
    const run = current.run;
    if (run === null || ['completed', 'idle'].includes(run.runnerState)) return;
    const item = current.items.find((row) => (
      !isQueuePlaceholder(row)
      && row.runRevision === run.runRevision
      && ['dispatching', 'active', 'saving', 'interrupted', 'needs_attention', 'staged'].includes(row.state)
    ));
    try {
      await commitQueue((document) => {
        let next = document;
        if (item !== undefined && !isQueuePlaceholder(item)) {
          next = updateQueueItem(next, item.queueItemId, { state: 'needs_attention', attentionCode: code }, new Date().toISOString());
        }
        return updateQueueRun(next, { runnerState: 'needs_attention', authorizationRequired: true });
      });
    } catch {
      // The native revision conflict remains visible through the next reload.
    }
    await releaseQueueResources(run.runRevision);
    dispatch({
      type: 'SHOW_TOAST',
      tone: 'warning',
      title: 'Queue paused',
      message: message ?? 'Review the highlighted batch, then choose Resume queue.',
    });
  }, [commitQueue, releaseQueueResources]);

  const refreshProductionStatus = useCallback((): Promise<boolean> => {
    if (!runtime || !stateRef.current.setup.completed || !stateRef.current.setup.credentials.runpodApiKey.configured) {
      return Promise.resolve(false);
    }
    if (gpuStartInFlightRef.current) return Promise.resolve(false);
    if (refreshInFlightRef.current !== null) return refreshInFlightRef.current;
    const operation = runtime.refresh(stateRef.current)
      .then(() => true, () => false)
      .finally(() => {
        if (refreshInFlightRef.current === operation) refreshInFlightRef.current = null;
      });
    refreshInFlightRef.current = operation;
    return operation;
  }, [runtime]);

  const observeProductionStatus = useCallback((): Promise<void> => {
    if (!runtime || !stateRef.current.setup.completed || !stateRef.current.setup.credentials.runpodApiKey.configured) {
      return Promise.resolve();
    }
    if (gpuStartInFlightRef.current) return Promise.resolve();
    if (observationInFlightRef.current !== null) return observationInFlightRef.current;
    // A strict startup/manual/pre-submit refresh is already at least as
    // authoritative as the advisory heartbeat, so do not queue duplicate work.
    if (refreshInFlightRef.current !== null) return refreshInFlightRef.current.then(() => undefined);
    const operation = runtime.observe(stateRef.current).finally(() => {
      if (observationInFlightRef.current === operation) observationInFlightRef.current = null;
    });
    observationInFlightRef.current = operation;
    return operation;
  }, [runtime]);

  useEffect(() => {
    let active = true;
    void adapter.queue.load().then(
      (snapshot) => {
        if (!active) return;
        queueSnapshotRef.current = snapshot;
        dispatch({ type: 'QUEUE_LOADED', snapshot });
      },
      (error: unknown) => {
        if (!active) return;
        const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'queue_store_unrecoverable';
        dispatch({ type: 'QUEUE_LOAD_FAILED', code });
      },
    );
    void adapter.queue.isNotificationPermissionGranted().then((granted) => {
      if (active) dispatch({ type: 'QUEUE_NOTIFICATION_PERMISSION', permission: granted ? 'granted' : 'denied' });
    }, () => {
      if (active) dispatch({ type: 'QUEUE_NOTIFICATION_PERMISSION', permission: 'denied' });
    });
    return () => { active = false; };
  }, [adapter.queue]);

  useEffect(() => () => {
    alarm.dispose();
    const runRevision = queueSnapshotRef.current.document.run?.runRevision;
    if (runRevision !== undefined) {
      void adapter.queue.setSleepPrevention({ runRevision, enabled: false }).catch(() => undefined);
      void adapter.queue.releaseRunner({ runRevision }).catch(() => undefined);
    }
  }, [adapter.queue, alarm]);

  useEffect(() => {
    if (!runtime || !state.setup.completed) return;
    void runtime.restoreLocalLibrary(stateRef.current).catch(() => undefined);
  }, [runtime, state.setup.completed, state.settings.defaultDestination]);

  useEffect(() => {
    if (!runtime) return;
    return runtime.subscribe((event) => {
      if (event.type === 'pod') dispatch({ type: 'SYNC_RUNTIME_POD', pod: event.pod });
      else if (event.type === 'batch') dispatch({ type: 'SYNC_RUNTIME_BATCH', batch: event.batch, assets: event.assets });
      else if (event.type === 'library') dispatch({ type: 'SYNC_RUNTIME_LIBRARY', assets: event.assets });
      else if (event.type === 'busy') {
        dispatch({ type: 'SYNC_RUNTIME_BUSY', batch: event.batch });
        if (queueRunIsActive(queueSnapshotRef.current.document)) {
          void parkQueue('batch_busy', `${event.batch.owner} is using the GPU. The local queue was not remotely reserved.`);
        }
      }
      else if (event.type === 'idle') dispatch({ type: 'RUNTIME_BATCH_IDLE' });
      else if (event.type === 'stop-guard-active') {
        dispatch({
          type: 'RUNTIME_STOP_GUARD_ACTIVE',
          podId: event.podId,
          message: event.message,
        });
        if (queueRunIsActive(queueSnapshotRef.current.document)) void parkQueue('gpu_stop_pending', event.message);
      }
      else if (event.type === 'create-recovery') dispatch({ type: 'SYNC_CREATE_RECOVERY', marker: event.marker });
      else if (event.type === 'studio') dispatch({ type: 'SYNC_STUDIO_STATE', studio: event.studio });
      else if (event.type === 'stop-blocked') dispatch({
        type: 'STUDIO_STOP_BLOCKED',
        owner: event.owner,
        completed: event.completed,
        total: event.total,
        message: event.message,
      });
      else if (event.type === 'stop-failed') dispatch({
        type: 'STUDIO_STOP_FAILED',
        message: event.message,
        retryable: event.retryable,
      });
      else if (event.type === 'stop-complete') dispatch({ type: 'STUDIO_STOPPED', alreadyStopped: event.alreadyStopped });
      else if (event.type === 'local-error') {
        const queueItemId = stateRef.current.batch?.queueItemId;
        if (queueItemId !== undefined) queueFailureCodesRef.current.set(queueItemId, event.code);
        dispatch({
          type: 'RUNTIME_LOCAL_ERROR',
          batchId: event.batchId,
          code: event.code,
          message: event.message,
          retryable: event.retryable,
        });
        if (queueRunIsActive(queueSnapshotRef.current.document)) void parkQueue(event.code, event.message);
      }
      else if (event.type === 'notice') dispatch({ type: 'SHOW_TOAST', tone: event.tone, title: event.title, message: event.message });
      else {
        if (event.scope === 'batch') {
          const queueItemId = stateRef.current.batch?.queueItemId;
          if (queueItemId !== undefined) {
            queueFailureCodesRef.current.set(queueItemId, event.code ?? 'queue_submission_failed');
          }
        }
        dispatch({ type: 'RUNTIME_ERROR', scope: event.scope, code: event.code, message: event.message, retryable: event.retryable });
        if (event.scope === 'batch' && queueRunIsActive(queueSnapshotRef.current.document)) {
          void parkQueue(event.code ?? 'queue_submission_failed', event.message);
        }
      }
    });
  }, [parkQueue, runtime]);

  useEffect(() => {
    if (!runtime) {
      setGpuSelectorSnapshot(null);
      setGpuSelectorOpen(false);
      setGpuSelectorBusy(false);
      setGpuSelectorError(null);
      setGpuPriceAttention(null);
      setGpuSwitchSnapshot(null);
      setGpuSwitchLoadState('ready');
      return;
    }
    let active = true;
    setGpuSwitchLoadState('loading');
    setGpuSelectorSnapshot(runtime.getGpuInventory());
    const unsubscribe = runtime.subscribeGpuInventory((snapshot) => {
      if (active) setGpuSelectorSnapshot(snapshot);
    });
    void runtime.loadGpuInventory().then((snapshot) => {
      if (active) setGpuSelectorSnapshot(snapshot);
    }, () => undefined);
    void runtime.loadGpuStart().then((result) => {
      if (active && result?.state === 'price_attention') setGpuPriceAttention(result);
    }, () => undefined);
    void runtime.loadGpuSwitch().then((snapshot) => {
      if (!active) return;
      setGpuSwitchSnapshot(snapshot);
      setGpuSwitchLoadState('ready');
    }, () => {
      if (active) setGpuSwitchLoadState('error');
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [runtime]);

  useEffect(() => {
    if (!runtime) return;
    const dispose = () => runtime.dispose();
    window.addEventListener('beforeunload', dispose);
    return () => window.removeEventListener('beforeunload', dispose);
  }, [runtime]);

  useEffect(() => {
    // Safe preferences deliberately do not persist credential metadata. Wait
    // for the native vault to confirm the RunPod key before network refresh;
    // otherwise an upgraded ad-hoc build can spend the full timeout probing
    // with a temporarily inaccessible keychain item. Worker-token metadata is
    // not a gate because Pod discovery must still expose billed compute and
    // its explicit Stop control when that separate credential needs repair.
    if (!runtime || !state.setup.completed || !state.setup.credentials.runpodApiKey.configured) return;
    let active = true;
    const sync = async () => {
      if (!active) return;
      // The first strict refresh and every later observation bind/verify the
      // current worker session before a heartbeat can use it.
      try {
        await observeProductionStatus();
      } catch {
        return;
      }
      if (!active) return;
      await runtime.heartbeat(
        stateRef.current,
        document.visibilityState === 'visible' ? 'foreground' : 'background',
      ).catch(() => undefined);
    };
    // Establish the first authoritative state immediately. Subsequent checks
    // are deliberately slower, receipt-free observations.
    void refreshProductionStatus().then((refreshed) => {
      if (!active || !refreshed) return;
      return runtime.heartbeat(
        stateRef.current,
        document.visibilityState === 'visible' ? 'foreground' : 'background',
      ).catch(() => undefined);
    });
    // RunPod lifecycle polling is read-only. Keep every open macOS and
    // Windows client aligned when another editor starts or explicitly stops
    // the shared disposable Pod, even while no batch is running.
    const triggerSync = () => { void sync(); };
    const timer = window.setInterval(triggerSync, CROSS_CLIENT_HEARTBEAT_MS);
    window.addEventListener('focus', triggerSync);
    window.addEventListener('online', triggerSync);
    document.addEventListener('visibilitychange', triggerSync);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', triggerSync);
      window.removeEventListener('online', triggerSync);
      document.removeEventListener('visibilitychange', triggerSync);
    };
  }, [observeProductionStatus, refreshProductionStatus, runtime, state.setup.completed, state.setup.credentials.runpodApiKey.configured]);

  useEffect(() => {
    let active = true;
    void adapter.credentialMetadata().then(
      (credentials) => {
        if (active) dispatch({ type: 'SET_CREDENTIAL_METADATA', credentials });
      },
      () => {
        if (active) dispatch({ type: 'SHOW_TOAST', tone: 'error', title: 'Credential vault unavailable', message: 'ImageForge could not read redacted credential metadata.' });
      },
    );
    return () => { active = false; };
  }, [adapter]);

  useEffect(() => {
    if (adapter.mode !== 'production' || !state.setup.completed) return;
    let active = true;
    void adapter.validateDestination(state.settings.defaultDestination).then(
      (validated) => {
        if (active) dispatch({ type: 'SET_DESTINATION_VALIDATED', validated });
      },
      () => {
        if (active) dispatch({ type: 'SET_DESTINATION_VALIDATED', validated: false });
      },
    );
    return () => { active = false; };
  }, [adapter, state.settings.defaultDestination, state.setup.completed]);

  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme;
    document.documentElement.dataset.density = state.settings.density;
  }, [state.settings.density, state.settings.theme]);

  useEffect(() => {
    if (adapter.mode !== 'production' || !state.setup.completed) return;
    if (state.batch?.canManage === true) {
      recoveryPointerRef.current = { id: state.batch.id, name: state.batch.name };
    }
    const recoveryOverride = clearRecoveryPointerRef.current
      ? null
      : state.batch?.canManage !== true
        ? recoveryPointerRef.current
        : undefined;
    try {
      persistSafePreferences(state, window.localStorage, recoveryOverride);
      if (clearRecoveryPointerRef.current) {
        clearRecoveryPointerRef.current = false;
        recoveryPointerRef.current = null;
      }
    } catch {
      // A storage failure must never affect GPU or batch control.
    }
  }, [adapter.mode, state.settings, state.setup.completed, state.setup.studioProfile, state.batch?.id, state.batch?.name, state.batch?.phase]);

  useEffect(() => {
    if (state.pod.lifecycleSequence === 0 || state.pod.phase !== 'selecting') return;
    if (runtime) {
      // Production Start is committed only by the mounted receipt-bound GPU
      // selector. A restored legacy `selecting` phase must never fall through
      // to the renderer-authorized RunPod provider path.
      return;
    }
    return adapter.runPodLifecycle(
      {
        preference: state.settings.gpuPreference,
        allowSlowEmergency: state.settings.slowEmergencyGpuEnabled,
      },
      (update) => dispatch({ type: 'SET_POD_PHASE', ...update }),
    );
    // A lifecycle is tied to the explicit start sequence, not each intermediate phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, runtime, state.pod.lifecycleSequence]);

  useEffect(() => {
    if (state.pod.phase !== 'stopping') return;
    if (runtime) return;
    return adapter.finishPodStop(() => dispatch({ type: 'POD_STOPPED' }));
  }, [adapter, runtime, state.pod.phase]);

  useEffect(() => {
    if (state.batch?.phase !== 'validating') return;
    if (runtime) {
      const queueItemId = state.batch.queueItemId;
      if (queueItemId === undefined) {
        void runtime.startBatch(stateRef.current).catch(() => undefined);
        return;
      }
      void queueMutationTailRef.current.then(async () => {
        const latest = stateRef.current;
        const document = queueSnapshotRef.current.document;
        const run = document.run;
        const row = document.items.find((item) => item.queueItemId === queueItemId);
        if (
          latest.batch?.phase !== 'validating'
          || latest.batch.queueItemId !== queueItemId
          || run === null
          || run.runnerState !== 'running'
          || run.authorizationRequired
          || queueAuthorizationRef.current !== run.runRevision
          || row === undefined
          || isQueuePlaceholder(row)
          || row.state !== 'dispatching'
          || row.runRevision !== run.runRevision
        ) return;
        queueRemoteCreateInFlightRef.current = queueItemId;
        try {
          await runtime.startBatch(latest);
        } finally {
          if (queueRemoteCreateInFlightRef.current === queueItemId) {
            queueRemoteCreateInFlightRef.current = null;
          }
        }
      }).catch(() => undefined);
      return;
    }
    return adapter.validateBatch(() => dispatch({ type: 'BATCH_VALIDATED' }));
  }, [adapter, runtime, state.batch?.phase]);

  useEffect(() => {
    if (runtime) return;
    if (state.batch?.phase !== 'running') return;
    return adapter.runBatchClock(state.settings.simulationSpeed, () => dispatch({ type: 'BATCH_TICK' }));
  }, [adapter, runtime, state.batch?.phase, state.settings.simulationSpeed]);

  useEffect(() => {
    if (!runtime || !['ready', 'reconnecting'].includes(state.pod.phase)) return;
    if (state.batch?.phase === 'validating') return;
    const poll = () => void runtime.pollBatch(stateRef.current).catch(() => undefined);
    poll();
    const timer = window.setInterval(poll, 1_500);
    return () => window.clearInterval(timer);
  }, [runtime, state.pod.phase, state.batch?.phase]);

  useEffect(() => {
    if (!state.toast) return;
    const timer = window.setTimeout(() => dispatch({ type: 'DISMISS_TOAST' }), 5_200);
    return () => window.clearTimeout(timer);
  }, [state.toast]);

  const showQueueError = useCallback((error: unknown, fallback: string) => {
    const message = userFacingErrorMessage(error, fallback);
    dispatch({ type: 'SHOW_TOAST', tone: 'error', title: 'Queue update failed', message });
  }, []);

  const stageDraft = useCallback(async () => {
    const current = stateRef.current;
    if (
      current.queue.loadState !== 'ready'
      || current.draft.prompts.length === 0
      || current.draft.destination === null
      || current.draft.issues.some((issue) => issue.level === 'error')
    ) {
      dispatch({ type: 'SHOW_TOAST', tone: 'warning', title: 'Batch is not ready to stage', message: 'Resolve the highlighted prompts and choose a downloads folder first.' });
      return;
    }
    try {
      const references = await snapshotQueueReferences(current.draft.references);
      const staged = createStagedQueueItem(
        current.draft,
        current.settings,
        references,
        new Date().toISOString(),
      );
      await commitQueue(
        (document) => replaceQueueItem(document, staged.item, current.draft.queueReplacementId),
        staged.referenceBlobs,
      );
      dispatch({ type: 'NEW_BATCH' });
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'success',
        title: current.draft.queueReplacementId ? 'Staged batch replaced' : 'Batch staged on this device',
        message: 'It is saved locally and is not reserved on the GPU.',
      });
    } catch (error) {
      showQueueError(error, 'The batch could not be saved to this device queue.');
    }
  }, [commitQueue, showQueueError]);

  const startQueueRun = useCallback(async () => {
    const current = stateRef.current;
    if (current.queue.loadState !== 'ready') return;
    if (current.batch !== null) {
      dispatch({ type: 'SHOW_TOAST', tone: 'warning', title: 'Finish the current batch first', message: 'The worker still permits exactly one active batch.' });
      return;
    }
    if (current.pod.phase !== 'ready' || current.pod.podId === null) {
      dispatch({ type: 'SHOW_TOAST', tone: 'warning', title: 'Start the GPU first', message: 'Run queue never starts a Pod automatically.' });
      return;
    }
    if (['pending', 'approved', 'finalizing'].includes(current.studio.stop.phase)) {
      dispatch({ type: 'SHOW_TOAST', tone: 'warning', title: 'GPU Stop is in progress', message: 'Resolve the shared Stop request before running this local queue.' });
      return;
    }
    const runRevision = crypto.randomUUID();
    try {
      // Persist the singular run before asking native code to lease it. The
      // production lease validates that exact durable revision; a permissive
      // in-memory fake must not hide this ordering requirement.
      await commitQueue((document) => createQueueRun(
        document,
        runRevision,
        current.queue.alarmTest === 'heard',
        current.queue.keepAwakePreference,
      ));
      const lease = await adapter.queue.acquireRunner({ runRevision });
      dispatch({ type: 'QUEUE_LEASE_CHANGED', lease });
      await commitQueue((document) => updateQueueRun(document, {
        runnerState: 'running',
        authorizationRequired: false,
      }));
      queueAuthorizationRef.current = runRevision;
      queuePodIdRef.current = current.pod.podId;
      if (current.queue.keepAwakePreference) {
        const power = await adapter.queue.setSleepPrevention({ runRevision, enabled: true });
        dispatch({ type: 'QUEUE_POWER_CHANGED', power });
      }
      dispatch({ type: 'SHOW_TOAST', tone: 'success', title: 'Queue running', message: 'ImageForge will submit one local snapshot at a time while this app stays open.' });
    } catch (error) {
      await adapter.queue.releaseRunner({ runRevision }).catch(() => undefined);
      await commitQueue((document) => document.run?.runRevision === runRevision
        ? updateQueueRun(document, { runnerState: 'paused', authorizationRequired: true })
        : document).catch(() => undefined);
      showQueueError(error, 'The local queue could not start.');
    }
  }, [adapter.queue, commitQueue, showQueueError]);

  const resumeQueue = useCallback(async () => {
    const current = stateRef.current;
    const run = current.queue.document.run;
    if (run === null) return;
    if (current.pod.phase !== 'ready' || current.pod.podId === null) {
      dispatch({ type: 'SHOW_TOAST', tone: 'warning', title: 'GPU is not ready', message: 'Start or restore the GPU explicitly, then Resume queue.' });
      return;
    }
    if (current.batch?.phase === 'locked') {
      dispatch({ type: 'SHOW_TOAST', tone: 'warning', title: 'GPU is busy', message: 'Another editor owns the active worker batch. The local queue remains paused.' });
      return;
    }
    try {
      const lease = await adapter.queue.acquireRunner({ runRevision: run.runRevision });
      dispatch({ type: 'QUEUE_LEASE_CHANGED', lease });
      const candidate = queueSnapshotRef.current.document.items.find((row) => (
        !isQueuePlaceholder(row)
        && row.runRevision === run.runRevision
        && !['completed', 'completed_with_failures', 'cancelled', 'historical'].includes(row.state)
      ));
      let reattachedBatchId: string | null = null;
      if (candidate !== undefined && !isQueuePlaceholder(candidate) && runtime) {
        reattachedBatchId = await runtime.reconcileQueueSubmission({
          queueItemId: candidate.queueItemId,
          clientSubmissionId: candidate.clientSubmissionId,
          name: candidate.name,
          destination: candidate.destination,
        });
        // Owner-only exact lookup always precedes status/preflight. A missing
        // association is safe to submit only for a never-accepted/uncertain
        // staged row, never for a row that recorded a remote batch.
        const refreshed = await refreshProductionStatus();
        const authoritativePod = runtime.getAuthoritativePodState?.() ?? stateRef.current.pod;
        if (!refreshed || authoritativePod.phase !== 'ready' || authoritativePod.podId === null) {
          throw Object.assign(new Error('The exact GPU could not be verified after submission lookup.'), { code: 'queue_pod_offline' });
        }
        if (queuePodIdRef.current !== null && queuePodIdRef.current !== authoritativePod.podId) {
          throw Object.assign(new Error('The GPU identity changed while the queue was paused.'), { code: 'queue_pod_replaced' });
        }
        if (reattachedBatchId === null && (candidate.remoteBatchId !== null || ['active', 'saving', 'interrupted'].includes(candidate.state))) {
          throw Object.assign(new Error('The previously accepted submission association is missing.'), { code: 'submission_not_found' });
        }
      }
      await commitQueue((document) => {
        const active = document.items.find((row) => (
          !isQueuePlaceholder(row)
          && row.runRevision === run.runRevision
          && ['dispatching', 'needs_attention', 'interrupted'].includes(row.state)
        ));
        const repaired = active !== undefined && !isQueuePlaceholder(active)
          ? updateQueueItem(document, active.queueItemId, {
              state: reattachedBatchId === null ? 'staged' : 'active',
              attentionCode: null,
              remoteBatchId: reattachedBatchId,
            }, new Date().toISOString())
          : document;
        return updateQueueRun(repaired, { runnerState: 'running', authorizationRequired: false });
      });
      queueAuthorizationRef.current = run.runRevision;
      queuePodIdRef.current = current.pod.podId;
      if (run.keepAwake) {
        const power = await adapter.queue.setSleepPrevention({ runRevision: run.runRevision, enabled: true });
        dispatch({ type: 'QUEUE_POWER_CHANGED', power });
      }
      if (reattachedBatchId !== null && current.batch?.phase === 'interrupted' && current.batch.queueItemId && runtime) {
        await runtime.controlBatch('resume', stateRef.current);
      }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'submission_uncertain';
      const message = error instanceof Error ? error.message : 'The queue could not resume safely.';
      await parkQueue(code, message);
    }
  }, [adapter.queue, commitQueue, parkQueue, refreshProductionStatus, runtime]);

  const pauseQueue = useCallback(async () => {
    const current = stateRef.current;
    const run = current.queue.document.run;
    if (run === null || !['running', 'pause_after_current'].includes(run.runnerState)) return;
    const queueItemId = current.batch?.queueItemId;
    const queuedRow = queueItemId === undefined
      ? undefined
      : queueSnapshotRef.current.document.items.find((row) => row.queueItemId === queueItemId);
    const pausingBeforeCreate = queueItemId !== undefined
      && current.batch?.phase === 'validating'
      && queueRemoteCreateInFlightRef.current !== queueItemId
      && queuedRow !== undefined
      && !isQueuePlaceholder(queuedRow)
      && queuedRow.state === 'dispatching';
    const active = queueItemId !== undefined && (
      queueRemoteCreateInFlightRef.current === queueItemId
      || ['running', 'paused'].includes(current.batch?.phase ?? '')
      || (queuedRow !== undefined
        && !isQueuePlaceholder(queuedRow)
        && ['active', 'saving', 'interrupted'].includes(queuedRow.state))
    );
    try {
      await commitQueue((document) => {
        const reverted = pausingBeforeCreate && queueItemId !== undefined
          ? updateQueueItem(
            document,
            queueItemId,
            { state: 'staged', attentionCode: null },
            new Date().toISOString(),
          )
          : document;
        return updateQueueRun(reverted, {
          runnerState: active ? 'pause_after_current' : 'paused',
          authorizationRequired: !active,
        });
      });
      if (pausingBeforeCreate) dispatch({ type: 'QUEUE_RELEASE_BATCH' });
      if (!active) await releaseQueueResources(run.runRevision);
    } catch (error) {
      showQueueError(error, 'The queue could not be paused.');
    }
  }, [commitQueue, releaseQueueResources, showQueueError]);

  const moveQueuedItem = useCallback(async (queueItemId: string, direction: -1 | 1) => {
    try {
      await commitQueue((document) => moveQueueItem(document, queueItemId, direction));
    } catch (error) {
      showQueueError(error, 'The staged batch could not move.');
    }
  }, [commitQueue, showQueueError]);

  const removeQueuedItem = useCallback(async (queueItemId: string) => {
    const row = queueSnapshotRef.current.document.items.find((item) => item.queueItemId === queueItemId);
    if (row === undefined) return;
    const runRevision = !isQueuePlaceholder(row) && row.runRevision !== null ? row.runRevision : null;
    const heldLease = stateRef.current.queue.lease;
    const needsRecoveryLease = runRevision !== null
      && isQueueLocallyRemovableIssue(row)
      && (heldLease?.held !== true || heldLease.runRevision !== runRevision);
    let acquiredRecoveryLease = false;
    try {
      if (needsRecoveryLease) {
        const lease = await adapter.queue.acquireRunner({ runRevision });
        dispatch({ type: 'QUEUE_LEASE_CHANGED', lease });
        acquiredRecoveryLease = true;
      }
      await commitQueue((document) => removeQueueItem(document, queueItemId, new Date().toISOString()));
    } catch (error) {
      showQueueError(error, 'The local batch could not be removed safely.');
    } finally {
      if (acquiredRecoveryLease && runRevision !== null) {
        await releaseQueueResources(runRevision);
      }
    }
  }, [adapter.queue, commitQueue, releaseQueueResources, showQueueError]);

  const editQueuedItem = useCallback(async (queueItemId: string) => {
    const row = queueSnapshotRef.current.document.items.find((item) => item.queueItemId === queueItemId);
    if (row === undefined || isQueuePlaceholder(row) || row.state !== 'staged') return;
    try {
      const payload = await adapter.queue.prepareDispatch({
        queueItemId,
        clientSubmissionId: row.clientSubmissionId,
        purpose: 'edit',
      });
      dispatch({ type: 'RESTORE_QUEUE_ITEM_TO_DRAFT', payload, styleSuffix: row.styleSuffix });
    } catch (error) {
      showQueueError(error, 'The staged batch could not be restored for editing.');
    }
  }, [adapter.queue, showQueueError]);

  const testQueueAlarm = useCallback(async () => {
    dispatch({ type: 'QUEUE_ALARM_TEST_STATE', state: 'playing' });
    try {
      await alarm.test();
      dispatch({ type: 'QUEUE_ALARM_TEST_STATE', state: 'tested' });
    } catch (error) {
      dispatch({ type: 'QUEUE_ALARM_TEST_STATE', state: 'blocked' });
      showQueueError(error, 'The alarm test could not play.');
    }
  }, [alarm, showQueueError]);

  const confirmQueueAlarm = useCallback(async () => {
    if (stateRef.current.queue.alarmTest !== 'tested') return;
    dispatch({ type: 'QUEUE_ALARM_TEST_STATE', state: 'heard' });
    try {
      const permission = await adapter.queue.requestNotificationPermission();
      dispatch({ type: 'QUEUE_NOTIFICATION_PERMISSION', permission: permission === 'granted' ? 'granted' : 'denied' });
    } catch {
      dispatch({ type: 'QUEUE_NOTIFICATION_PERMISSION', permission: 'denied' });
    }
  }, [adapter.queue]);

  const dismissQueueAlarm = useCallback(async () => {
    alarm.stop();
    try {
      await commitQueue((document) => document.alarm === null
        ? document
        : { ...document, alarm: { ...document.alarm, state: 'acknowledged', snoozeDueAt: null } });
    } catch (error) {
      showQueueError(error, 'The alarm acknowledgement could not be saved.');
    }
  }, [alarm, commitQueue, showQueueError]);

  const snoozeQueueAlarm = useCallback(async () => {
    const alarmState = queueSnapshotRef.current.document.alarm;
    if (alarmState === null || alarmState.snoozeUsed || alarmState.state !== 'ringing') return;
    alarm.stop();
    const due = new Date(Date.now() + 15 * 60_000).toISOString();
    try {
      await commitQueue((document) => document.alarm === null ? document : {
        ...document,
        alarm: { ...document.alarm, state: 'snoozed', snoozeUsed: true, snoozeDueAt: due },
      });
    } catch (error) {
      showQueueError(error, 'The alarm could not be snoozed.');
    }
  }, [alarm, commitQueue, showQueueError]);

  const clearQueueCompleted = useCallback(async () => {
    const current = queueSnapshotRef.current.document;
    if (current.run?.runnerState !== 'completed' || current.alarm?.state !== 'acknowledged') return;
    const cohort = new Set(current.run.cohortItemIds);
    try {
      await commitQueue((document) => ({
        ...document,
        items: document.items.map((row) => {
          if (isQueuePlaceholder(row) || !cohort.has(row.queueItemId) || !['completed', 'completed_with_failures', 'cancelled'].includes(row.state)) return row;
          const archived = { ...row, state: 'historical' as const, recordRevision: row.recordRevision + 1, updatedAt: new Date().toISOString() };
          assertQueueItemTransition(row, archived);
          return archived;
        }),
      }));
    } catch (error) {
      showQueueError(error, 'Completed rows could not be archived.');
    }
  }, [commitQueue, showQueueError]);

  const clearQueueHistoryRows = useCallback(async () => {
    try {
      await commitQueue(clearQueueHistory);
    } catch (error) {
      showQueueError(error, 'Queue history could not be cleared.');
    }
  }, [commitQueue, showQueueError]);

  const resetLocalQueue = useCallback(async () => {
    alarm.stop();
    try {
      const snapshot = await adapter.queue.reset({ confirmation: 'RESET LOCAL QUEUE' });
      queueSnapshotRef.current = snapshot;
      queueAuthorizationRef.current = null;
      queuePodIdRef.current = null;
      dispatch({ type: 'QUEUE_LOADED', snapshot });
      dispatch({ type: 'DISMISS_DIALOG' });
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'success',
        title: 'Local queue reset',
        message: 'The unrecoverable queue was quarantined. No GPU or downloaded image was changed.',
      });
    } catch (error) {
      dispatch({ type: 'DISMISS_DIALOG' });
      showQueueError(error, 'The local queue could not be reset safely.');
    }
  }, [adapter.queue, alarm, showQueueError]);

  useEffect(() => {
    const document = state.queue.document;
    const run = document.run;
    if (
      state.queue.loadState !== 'ready'
      || run === null
      || run.runnerState !== 'running'
      || run.authorizationRequired
      || queueAuthorizationRef.current !== run.runRevision
      || queueDispatchInFlightRef.current
    ) return;
    if (state.batch?.phase === 'locked') {
      void parkQueue('batch_busy', `${state.batch.owner} owns the active GPU batch. The local queue was not reserved.`);
      return;
    }
    if (state.batch !== null) return;
    const item = nextQueueItem(document);
    if (item === null) return;
    queueDispatchInFlightRef.current = true;
    void (async () => {
      try {
        if (['pending', 'approved', 'finalizing'].includes(stateRef.current.studio.stop.phase)) {
          await parkQueue('queue_stop_pending', 'A shared GPU Stop request is in progress.');
          return;
        }
        const foundBatchId = runtime ? await runtime.reconcileQueueSubmission({
          queueItemId: item.queueItemId,
          clientSubmissionId: item.clientSubmissionId,
          name: item.name,
          destination: item.destination,
        }) : null;
        if (foundBatchId !== null) return;
        if (runtime) {
          const refreshed = await refreshProductionStatus();
          const authoritativePod = runtime.getAuthoritativePodState?.() ?? stateRef.current.pod;
          if (!refreshed || authoritativePod.phase !== 'ready' || authoritativePod.podId === null) {
            await parkQueue('queue_pod_offline', 'The exact GPU could not be verified. Start or restore it explicitly, then Resume queue.');
            return;
          }
          if (queuePodIdRef.current !== null && queuePodIdRef.current !== authoritativePod.podId) {
            await parkQueue('queue_pod_replaced', 'The GPU identity changed. Review it before resuming this queue.');
            return;
          }
        }
        const payload = await adapter.queue.prepareDispatch({
          queueItemId: item.queueItemId,
          clientSubmissionId: item.clientSubmissionId,
          purpose: 'dispatch',
        });
        const beforeCommit = queueSnapshotRef.current.document;
        const beforeRun = beforeCommit.run;
        const stillSelected = nextQueueItem(beforeCommit);
        if (
          beforeRun === null
          || beforeRun.runnerState !== 'running'
          || beforeRun.authorizationRequired
          || queueAuthorizationRef.current !== beforeRun.runRevision
          || stillSelected?.queueItemId !== item.queueItemId
        ) return;
        queueFailureCodesRef.current.delete(item.queueItemId);
        const committed = await commitQueue((current) => {
          const currentRun = current.run;
          const selected = nextQueueItem(current);
          if (
            currentRun === null
            || currentRun.runnerState !== 'running'
            || currentRun.authorizationRequired
            || queueAuthorizationRef.current !== currentRun.runRevision
            || selected?.queueItemId !== item.queueItemId
          ) {
            throw Object.assign(new Error('The queue was paused before remote admission.'), { code: 'queue_dispatch_cancelled' });
          }
          return updateQueueItem(
            current,
            item.queueItemId,
            { state: 'dispatching', attentionCode: null },
            new Date().toISOString(),
          );
        });
        const committedRun = committed.document.run;
        const committedRow = committed.document.items.find((row) => row.queueItemId === item.queueItemId);
        if (
          committedRun === null
          || committedRun.runnerState !== 'running'
          || committedRun.authorizationRequired
          || queueAuthorizationRef.current !== committedRun.runRevision
          || committedRow === undefined
          || isQueuePlaceholder(committedRow)
          || committedRow.state !== 'dispatching'
        ) return;
        dispatch({ type: 'QUEUE_DISPATCH_ITEM', payload, startedAt: new Date().toISOString() });
      } catch (error) {
        const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'submission_uncertain';
        if (code === 'queue_dispatch_cancelled') return;
        const message = error instanceof Error ? error.message : 'Queue admission could not be confirmed.';
        await parkQueue(code, message);
      } finally {
        queueDispatchInFlightRef.current = false;
      }
    })();
  }, [
    adapter.queue,
    commitQueue,
    parkQueue,
    refreshProductionStatus,
    runtime,
    state.batch,
    state.queue.document,
    state.queue.loadState,
  ]);

  useEffect(() => {
    const batch = state.batch;
    if (batch?.queueItemId === undefined || queueBatchSyncInFlightRef.current) return;
    const row = state.queue.document.items.find((item) => item.queueItemId === batch.queueItemId);
    if (row === undefined || isQueuePlaceholder(row)) return;
    let nextState: typeof row.state | null = null;
    let attentionCode: string | null = null;
    if (['running', 'paused'].includes(batch.phase)) nextState = 'active';
    else if (batch.phase === 'complete') nextState = 'completed';
    else if (batch.phase === 'partial_failure') nextState = 'completed_with_failures';
    else if (batch.phase === 'cancelled') nextState = 'cancelled';
    else if (batch.phase === 'interrupted') {
      nextState = 'interrupted';
      attentionCode = 'queue_batch_interrupted';
    } else if (batch.phase === 'error') {
      nextState = 'needs_attention';
      attentionCode = queueFailureCodesRef.current.get(row.queueItemId)
        ?? state.localSyncIssue?.code
        ?? 'queue_batch_failed';
    }
    if (nextState === null) return;
    const acceptedPhase = ['running', 'paused', 'complete', 'partial_failure', 'cancelled', 'interrupted'].includes(batch.phase);
    const remoteBatchId = acceptedPhase && isCanonicalQueueUuid(batch.id) ? batch.id : row.remoteBatchId;
    if (row.state === nextState && row.attentionCode === attentionCode && row.remoteBatchId === remoteBatchId) return;
    queueBatchSyncInFlightRef.current = true;
    void (async () => {
      const commitState = (target: typeof row.state, code: string | null, applyRunnerPolicy: boolean) => commitQueue((document) => {
        const currentRow = document.items.find((item) => item.queueItemId === row.queueItemId);
        if (currentRow === undefined || isQueuePlaceholder(currentRow)) throw new Error('The active queue item disappeared.');
        const targetRemote = target === 'staged' || target === 'dispatching' ? null : remoteBatchId;
        if (currentRow.state === target && currentRow.attentionCode === code && currentRow.remoteBatchId === targetRemote) return document;
        let next = updateQueueItem(document, row.queueItemId, {
          state: target,
          attentionCode: code,
          remoteBatchId: targetRemote,
        }, new Date().toISOString());
        const run = next.run;
        if (applyRunnerPolicy && run !== null) {
          if (['interrupted', 'needs_attention'].includes(target)) {
            next = updateQueueRun(next, { runnerState: 'needs_attention', authorizationRequired: true });
          } else if (target === 'cancelled') {
            next = updateQueueRun(next, { runnerState: 'paused', authorizationRequired: true });
          } else if (run.runnerState === 'pause_after_current' && !queueCohortAtFixedPoint(next)) {
            next = updateQueueRun(next, { runnerState: 'paused', authorizationRequired: true });
          }
        }
        return next;
      });

      let currentState = row.state;
      const terminal = nextState === 'completed' || nextState === 'completed_with_failures';
      if ((nextState === 'active' || terminal) && currentState === 'staged') {
        await commitState('dispatching', null, false);
        currentState = 'dispatching';
      }
      if ((nextState === 'active' || terminal) && ['dispatching', 'needs_attention', 'interrupted'].includes(currentState)) {
        await commitState('active', null, false);
        currentState = 'active';
      }
      if (terminal && currentState === 'active') {
        await commitState('saving', null, false);
      }
      const snapshot = await commitState(nextState!, attentionCode, true);
      if (['completed', 'completed_with_failures', 'cancelled'].includes(nextState!)) {
        queueFailureCodesRef.current.delete(row.queueItemId);
        runtime?.beginNewBatch();
        dispatch({ type: 'QUEUE_RELEASE_BATCH' });
      }
      const run = snapshot.document.run;
      if (run !== null && ['paused', 'needs_attention'].includes(run.runnerState)) {
        await releaseQueueResources(run.runRevision);
      }
    })().catch((error: unknown) => {
      showQueueError(error, 'The queue could not record the current batch state.');
    }).finally(() => {
      queueBatchSyncInFlightRef.current = false;
    });
  }, [
    commitQueue,
    releaseQueueResources,
    runtime,
    showQueueError,
    state.batch,
    state.localSyncIssue?.code,
    state.queue.document.items,
  ]);

  useEffect(() => {
    const document = state.queue.document;
    const run = document.run;
    const alarmState = document.alarm;
    if (
      run === null
      || alarmState === null
      || run.runnerState === 'completed'
      || !queueCohortAtFixedPoint(document)
      || queueCompletionInFlightRef.current
    ) return;
    queueCompletionInFlightRef.current = true;
    const kind = queueCompletionKind(document);
    const shouldRing = alarmState.state === 'armed';
    void commitQueue((current) => ({
      ...updateQueueRun(current, { runnerState: 'completed', authorizationRequired: true }),
      alarm: current.alarm === null ? null : {
        ...current.alarm,
        kind,
        state: shouldRing ? 'ringing' : 'disarmed',
        notificationDisposition: shouldRing ? 'pending' : null,
      },
    })).then(async () => {
      await releaseQueueResources(run.runRevision);
      if (shouldRing && stateRef.current.queue.alarmTest === 'heard') {
        await alarm.ring().catch(() => undefined);
      }
    }).catch((error: unknown) => {
      showQueueError(error, 'Queue completion could not be recorded.');
    }).finally(() => {
      queueCompletionInFlightRef.current = false;
    });
  }, [alarm, commitQueue, releaseQueueResources, showQueueError, state.queue.document]);

  useEffect(() => {
    const alarmState = state.queue.document.alarm;
    if (alarmState === null) return;
    void deliverQueueNotification(alarmState);
  }, [deliverQueueNotification, state.queue.document.alarm]);

  useEffect(() => {
    const alarmState = state.queue.document.alarm;
    if (alarmState?.state !== 'snoozed' || alarmState.snoozeDueAt === null) return;
    const due = new Date(alarmState.snoozeDueAt).valueOf();
    const delay = Math.max(0, due - Date.now());
    const timer = window.setTimeout(() => {
      void commitQueue((document) => {
        const current = document.alarm;
        if (
          current?.eventId !== alarmState.eventId
          || current.state !== 'snoozed'
          || !current.snoozeUsed
          || current.snoozeDueAt !== alarmState.snoozeDueAt
        ) return document;
        return {
          ...document,
          alarm: {
            ...current,
            state: 'ringing',
            snoozeDueAt: null,
            snoozeNotificationDisposition: 'pending',
          },
        };
      }).then(async (snapshot) => {
        const current = snapshot.document.alarm;
        if (
          current?.eventId === alarmState.eventId
          && current.state === 'ringing'
          && current.snoozeUsed
          && current.snoozeDueAt === null
          && stateRef.current.queue.alarmTest === 'heard'
        ) await alarm.ring().catch(() => undefined);
      }).catch(() => undefined);
    }, Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [alarm, commitQueue, state.queue.document.alarm]);

  const prepareGpuSelector = useCallback(async (captureReturnFocus: boolean) => {
    if (!runtime) return;
    const current = stateRef.current;
    if (gpuSwitchLoadState !== 'ready' || gpuSwitchSnapshot?.record !== null && gpuSwitchSnapshot?.record !== undefined) {
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'warning',
        title: 'GPU switch recovery is paused',
        message: gpuSwitchLoadState === 'loading'
          ? 'ImageForge is still verifying the durable GPU Switch journal. No GPU mutation is allowed yet.'
          : gpuSwitchLoadState === 'error'
            ? 'ImageForge could not verify the durable GPU Switch journal, so no GPU mutation is allowed.'
          : 'ImageForge found a durable GPU Switch. It will not start or replace a Pod until the native recovery controls are available.',
      });
      return;
    }
    if (current.pod.createRecovery !== null) {
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'warning',
        title: 'Resolve the interrupted start first',
        message: 'ImageForge will not risk creating a duplicate billed Pod.',
      });
      return;
    }
    const switchMode = current.pod.podId !== null;
    if (switchMode ? current.pod.phase !== 'ready' : !['offline', 'error'].includes(current.pod.phase)) {
      dispatch({
        type: 'SHOW_TOAST',
        tone: 'info',
        title: 'Current GPU remains unchanged',
        message: current.pod.podId === null
          ? 'Wait for the current GPU transition to finish before choosing again.'
          : 'Wait for the current managed GPU to become Ready before choosing a replacement.',
      });
      return;
    }
    setGpuSelectorMode(switchMode ? 'switch' : 'offline_start');
    const requestId = gpuSelectorRequestRef.current + 1;
    gpuSelectorRequestRef.current = requestId;
    setGpuSelectorError(null);
    // Opening from a closed state has no mounted selector to preserve. During
    // an in-place Refresh, keep the existing sheet mounted until native
    // publishes its loading snapshot; clearing it here briefly replaced the
    // selector with the journal placeholder and exposed the page behind it.
    // The native loading snapshot still removes all receipt authority and
    // disables every row before any refreshed result can be selected.
    if (captureReturnFocus) setGpuSelectorSnapshot(null);
    if (captureReturnFocus) {
      gpuSelectorReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setGpuSelectorOpen(true);
    }
    setGpuSelectorBusy(true);
    let timeoutId: number | undefined;
    try {
      const snapshot = await Promise.race([
        runtime.prepareGpuInventory(current),
        new Promise<NativeGpuInventorySnapshotV1>((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error(
            'Live GPU inventory did not respond in time. Check the network and retry.',
          )), GPU_SELECTOR_LOAD_TIMEOUT_MS);
        }),
      ]);
      if (gpuSelectorRequestRef.current !== requestId) return;
      // Native refresh returns an immediate loading projection and publishes
      // the terminal receipt through the inventory subscription. The event
      // can arrive before this promise continuation; never let that newer
      // same-observation projection regress the selector back to loading.
      const latestSnapshot = runtime.getGpuInventory();
      setGpuSelectorSnapshot(
        latestSnapshot?.observationId === snapshot.observationId
          ? latestSnapshot
          : snapshot,
      );
      setGpuSelectorError(null);
    } catch (error) {
      if (gpuSelectorRequestRef.current !== requestId) return;
      const native = asNativeError(error);
      const message = userFacingErrorMessage(error, 'Live GPU inventory could not be refreshed.');
      setGpuSelectorSnapshot(null);
      setGpuSelectorError({ code: native.code, message, retryable: native.retryable });
      dispatch({ type: 'RUNTIME_ERROR', scope: 'pod', message });
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (gpuSelectorRequestRef.current === requestId) setGpuSelectorBusy(false);
    }
  }, [gpuSwitchLoadState, gpuSwitchSnapshot, runtime]);

  // Keep the open sheet's receipt live. Without this a selector left on screen
  // for longer than the native receipt window shows startable rows whose paid
  // click can only fail; the user then has to guess that Refresh is required.
  useEffect(() => {
    if (runtime === undefined || !gpuSelectorOpen || gpuSelectorBusy || gpuSelectorConfirming) return;
    const receipt = gpuSelectorSnapshot?.receipt ?? null;
    if (receipt === null) return;
    const receivedAtMs = Date.parse(receipt.receivedAt);
    if (!Number.isFinite(receivedAtMs)) return;
    const dueAtMs = receivedAtMs + receipt.validForMs - GPU_SELECTOR_RECEIPT_REFRESH_LEAD_MS;
    const timer = window.setTimeout(
      () => { void prepareGpuSelector(false); },
      Math.max(0, dueAtMs - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [
    gpuSelectorBusy,
    gpuSelectorConfirming,
    gpuSelectorOpen,
    gpuSelectorSnapshot,
    prepareGpuSelector,
    runtime,
  ]);

  const commitGpuSelectorChoice = useCallback((confirmation: GpuSelectorConfirmationV1) => {
    if (!runtime) return;
    if (confirmation.kind === 'switch') {
      setGpuSelectorBusy(true);
      void runtime.beginGpuSwitch(stateRef.current, confirmation).then(
        (snapshot) => {
          setGpuSwitchSnapshot(snapshot);
          setGpuSwitchLoadState('ready');
          closeGpuSelector();
        },
        (error: unknown) => {
          const message = userFacingErrorMessage(error, 'The coordinated GPU Switch could not begin safely.');
          dispatch({ type: 'RUNTIME_ERROR', scope: 'pod', message });
        },
      ).finally(() => setGpuSelectorBusy(false));
      return;
    }
    if (gpuStartInFlightRef.current) return;
    const pendingRefresh = refreshInFlightRef.current;
    const pendingObservation = observationInFlightRef.current;
    gpuStartInFlightRef.current = true;
    setGpuSelectorBusy(true);
    // Native Pod observation intentionally holds the shared profile lease
    // across its provider GET. Let that read-only owner finish before opening
    // the native paid-action confirmation; new observations are suppressed by
    // gpuStartInFlightRef for the whole foreground action.
    let recoverInventory = false;
    void Promise.allSettled([
      ...(pendingRefresh === null ? [] : [pendingRefresh]),
      ...(pendingObservation === null ? [] : [pendingObservation]),
    ]).then(() => runtime.startGpuChoice(stateRef.current, confirmation)).then(
      (result) => {
        closeGpuSelector();
        setGpuPriceAttention(result.state === 'price_attention' ? result : null);
      },
      (error: unknown) => {
        const message = userFacingErrorMessage(error, 'The selected GPU could not be started safely.');
        dispatch({ type: 'RUNTIME_ERROR', scope: 'pod', message });
        recoverInventory = GPU_START_INVENTORY_RECOVERY_CODES.has(asNativeError(error).code);
      },
    ).finally(() => {
      gpuStartInFlightRef.current = false;
      setGpuSelectorBusy(false);
      // Ordered after the busy reset so the recovery refresh owns the pending
      // state it sets for itself.
      if (recoverInventory) void prepareGpuSelector(false);
    });
  }, [closeGpuSelector, prepareGpuSelector, runtime]);

  const confirmGpuPriceAttention = useCallback(() => {
    if (
      !runtime
      || gpuPriceAttention?.state !== 'price_attention'
      || gpuPriceAttention.actualHourlyPriceMicroUsd === null
    ) return;
    setGpuPriceConfirmBusy(true);
    void runtime.confirmGpuActualPrice(
      stateRef.current,
      gpuPriceAttention.operationId,
      gpuPriceAttention.actualHourlyPriceMicroUsd,
    ).then((result) => {
      setGpuPriceAttention(result.state === 'price_attention' ? result : null);
    }, (error: unknown) => {
      const message = userFacingErrorMessage(error, 'The actual GPU price could not be confirmed safely.');
      dispatch({ type: 'RUNTIME_ERROR', scope: 'pod', message });
    }).finally(() => setGpuPriceConfirmBusy(false));
  }, [gpuPriceAttention, runtime]);

  const runGpuSwitchProgressAction = useCallback((action: GpuSwitchProgressActionV1) => {
    if (!runtime || gpuSwitchSnapshot?.record === null || gpuSwitchSnapshot?.record === undefined) return;
    const record = gpuSwitchSnapshot.record;
    setGpuSwitchActionBusy(action);
    let operation: Promise<NativeGpuSwitchSnapshotV1>;
    switch (action) {
      case 'resume':
        operation = runtime.resumeGpuSwitch(gpuSwitchSnapshot);
        break;
      case 'sync_worker':
        operation = runtime.syncGpuSwitch(gpuSwitchSnapshot);
        break;
      case 'confirm_target':
        operation = runtime.confirmGpuSwitchTarget(stateRef.current, gpuSwitchSnapshot);
        break;
      case 'finalize':
        operation = runtime.finalizeGpuSwitch(stateRef.current, gpuSwitchSnapshot);
        break;
      case 'delete_old':
        operation = runtime.deleteOldGpuSwitch(stateRef.current, gpuSwitchSnapshot);
        break;
      case 'prepare_attempt':
        operation = runtime.prepareGpuSwitchAttempt(stateRef.current, gpuSwitchSnapshot);
        break;
      case 'confirm_attempt':
        operation = runtime.confirmGpuSwitchAttempt(gpuSwitchSnapshot);
        break;
      case 'create_replacement':
        operation = runtime.createGpuSwitchReplacement(stateRef.current, gpuSwitchSnapshot);
        break;
      case 'confirm_actual_price':
        operation = runtime.confirmGpuSwitchActualPrice(gpuSwitchSnapshot);
        break;
      case 'delete_replacement': {
        const rejectedPrice = record.blockedAt === 'replacement_identified'
          || record.phase === 'replacement_identified';
        operation = runtime.deleteGpuSwitchReplacement(
          gpuSwitchSnapshot,
          rejectedPrice ? 'actual_price_rejected' : 'replacement_failed',
        );
        break;
      }
      case 'reconcile_provider': {
        const blockedPhase = record.phase === 'needs_attention' ? record.blockedAt : record.phase;
        const reason = blockedPhase === 'delete_intent' || blockedPhase === 'delete_uncertain'
          ? 'after_delete'
          : blockedPhase === 'create_intent' || blockedPhase === 'create_uncertain'
            ? 'after_create'
            : blockedPhase === 'replacement_delete_intent'
                || blockedPhase === 'replacement_delete_uncertain'
              ? 'after_replacement_delete'
              : blockedPhase === 'provisioning' || blockedPhase === 'replacement_failed'
                ? 'provisioning'
                : 'resume';
        operation = runtime.reconcileGpuSwitchProvider(gpuSwitchSnapshot, reason);
        break;
      }
      case 'verify_replacement':
        operation = runtime.verifyGpuSwitchReplacement(gpuSwitchSnapshot);
        break;
      case 'complete':
        operation = runtime.completeGpuSwitch(gpuSwitchSnapshot);
        break;
      case 'cancel':
        operation = runtime.cancelGpuSwitch(gpuSwitchSnapshot);
        break;
      default: {
        const unreachable: never = action;
        throw new Error(`Unsupported GPU Switch action: ${String(unreachable)}`);
      }
    }
    void operation.then((snapshot) => {
      setGpuSwitchSnapshot(snapshot);
      setGpuSwitchLoadState('ready');
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : 'The GPU Switch action could not be verified safely.';
      dispatch({ type: 'RUNTIME_ERROR', scope: 'pod', message });
      setGpuSwitchLoadState('loading');
      return runtime.loadGpuSwitch().then((snapshot) => {
        setGpuSwitchSnapshot(snapshot);
        setGpuSwitchLoadState('ready');
      }, () => setGpuSwitchLoadState('error'));
    }).finally(() => setGpuSwitchActionBusy(null));
  }, [gpuSwitchSnapshot, runtime]);

  const uiDispatch = useCallback((action: AppAction) => {
    if (action.type === 'STAGE_DRAFT') {
      void stageDraft();
      return;
    }
    if (action.type === 'RUN_QUEUE') {
      void startQueueRun();
      return;
    }
    if (action.type === 'RESUME_QUEUE') {
      void resumeQueue();
      return;
    }
    if (action.type === 'PAUSE_QUEUE') {
      void pauseQueue();
      return;
    }
    if (action.type === 'MOVE_QUEUE_ITEM') {
      void moveQueuedItem(action.queueItemId, action.direction);
      return;
    }
    if (action.type === 'REMOVE_QUEUE_ITEM') {
      void removeQueuedItem(action.queueItemId);
      return;
    }
    if (action.type === 'EDIT_QUEUE_ITEM') {
      void editQueuedItem(action.queueItemId);
      return;
    }
    if (action.type === 'TEST_QUEUE_ALARM') {
      void testQueueAlarm();
      return;
    }
    if (action.type === 'CONFIRM_QUEUE_ALARM') {
      void confirmQueueAlarm();
      return;
    }
    if (action.type === 'SNOOZE_QUEUE_ALARM') {
      void snoozeQueueAlarm();
      return;
    }
    if (action.type === 'DISMISS_QUEUE_ALARM') {
      void dismissQueueAlarm();
      return;
    }
    if (action.type === 'RING_QUEUE_ALARM') {
      const currentAlarm = stateRef.current.queue.document.alarm;
      void alarm.ring().catch((error: unknown) => showQueueError(error, 'The alarm could not start.'));
      if (currentAlarm !== null) void deliverQueueNotification(currentAlarm, true);
      return;
    }
    if (action.type === 'CLEAR_QUEUE_COMPLETED') {
      void clearQueueCompleted();
      return;
    }
    if (action.type === 'CLEAR_QUEUE_HISTORY') {
      void clearQueueHistoryRows();
      return;
    }
    if (action.type === 'CONFIRM_RESET_QUEUE') {
      void resetLocalQueue();
      return;
    }
    if (!runtime) {
      dispatch(action);
      return;
    }
    if (action.type === 'START_POD' || action.type === 'OPEN_GPU_SELECTOR') {
      void prepareGpuSelector(true);
      return;
    }
    const current = stateRef.current;
    if (action.type === 'NEW_BATCH') {
      const terminalOrEmpty = current.batch === null || ['complete', 'partial_failure', 'cancelled', 'error'].includes(current.batch.phase);
      if (terminalOrEmpty) {
        clearRecoveryPointerRef.current = true;
        runtime.beginNewBatch();
      }
    }
    if (action.type === 'TOGGLE_BATCH_PAUSE') {
      const control = current.batch?.phase === 'running' ? 'pause' : 'resume';
      void runtime.controlBatch(control, current).catch(() => undefined);
      return;
    }
    if (action.type === 'RETRY_FAILED') {
      void runtime.controlBatch('retry_failed', current).catch(() => undefined);
      return;
    }
    if (action.type === 'RESUME_INTERRUPTED_BATCH') {
      void runtime.controlBatch('resume', current).catch(() => undefined);
      return;
    }
    if (action.type === 'CONFIRM_CANCEL_BATCH') {
      dispatch({ type: 'DISMISS_DIALOG' });
      void runtime.controlBatch('cancel', current).catch(() => undefined);
      return;
    }
    if (action.type === 'CONFIRM_STOP_POD') {
      if (
        current.dialog?.type !== 'stop-pod'
        || current.dialog.podId !== current.pod.podId
        || current.pod.podId === null
      ) {
        dispatch(action);
        return;
      }
      void (async () => {
        if (queueRunIsActive(stateRef.current.queue.document)) {
          await pauseQueue();
        }
        const latest = stateRef.current;
        if (latest.pod.podId !== current.pod.podId) {
          dispatch({ type: 'DISMISS_DIALOG' });
          dispatch({ type: 'SHOW_TOAST', tone: 'warning', title: 'GPU changed', message: 'Refresh and confirm the exact current GPU before stopping it.' });
          return;
        }
        dispatch({
          type: 'BEGIN_STUDIO_STOP',
          podId: current.pod.podId!,
          gpuDisplayName: current.pod.gpu ?? 'ImageForge GPU',
        });
        await runtime.requestGpuStop(latest).catch(() => undefined);
      })();
      return;
    }
    if (action.type === 'RESPOND_STUDIO_STOP') {
      void runtime.respondToGpuStop(action.requestId, action.decision).catch(() => undefined);
      return;
    }
    if (action.type === 'CANCEL_STUDIO_STOP') {
      void runtime.cancelGpuStop(action.requestId).catch(() => undefined);
      return;
    }
    if (action.type === 'RESPOND_STUDIO_GPU_SWITCH') {
      void runtime.respondToGpuSwitch(action.switchId, action.decision).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'The GPU Switch response could not be recorded safely.';
        dispatch({ type: 'RUNTIME_ERROR', scope: 'pod', message });
      });
      return;
    }
    if (action.type === 'START_BATCH') {
      // A remote Stop GPU can land between the last heartbeat and this click.
      // Re-read RunPod before allowing the reducer to create a validating
      // batch, so a stale ready card cannot submit to a dead worker.
      if (batchStartInFlightRef.current) return;
      batchStartInFlightRef.current = true;
      setBatchStartPending(true);
      void refreshProductionStatus()
        .then(async (refreshed) => {
          if (!refreshed) {
            dispatch({
              type: 'SHOW_TOAST',
              tone: 'warning',
              title: 'GPU status unavailable',
              message: 'ImageForge could not verify the shared GPU. Generation is blocked until RunPod status is reachable.',
            });
            return;
          }
          const authoritativePod = runtime.getAuthoritativePodState?.();
          if (authoritativePod !== undefined && authoritativePod !== null) {
            dispatch({ type: 'SYNC_RUNTIME_POD', pod: authoritativePod });
          }
          // Let the authoritative Pod event settle before reducer validation.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          const latest = stateRef.current;
          const candidate = authoritativePod === undefined || authoritativePod === null
            ? latest
            : { ...latest, pod: authoritativePod };
          if (!canStartBatch(candidate)) {
            dispatch({
              type: 'SHOW_TOAST',
              tone: 'warning',
              title: 'GPU is not ready',
              message: 'The shared GPU was stopped or changed on another ImageForge client. Wait for status to synchronize before generating.',
            });
            return;
          }
          dispatch(action);
        })
        .finally(() => {
          batchStartInFlightRef.current = false;
          setBatchStartPending(false);
        });
      return;
    }
    if (action.type === 'CONFIRM_RESOLVE_CREATE') {
      dispatch(action);
      void runtime.resolveAmbiguousStart().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'The interrupted RunPod create could not be resolved.';
        dispatch({ type: 'RUNTIME_ERROR', scope: 'pod', message });
      });
      return;
    }
    if (action.type === 'REFRESH_STATUS') {
      dispatch(action);
      void refreshProductionStatus();
      return;
    }
    dispatch(action);
  }, [
    alarm,
    clearQueueCompleted,
    clearQueueHistoryRows,
    confirmQueueAlarm,
    dismissQueueAlarm,
    editQueuedItem,
    moveQueuedItem,
    pauseQueue,
    prepareGpuSelector,
    refreshProductionStatus,
    removeQueuedItem,
    resetLocalQueue,
    resumeQueue,
    runtime,
    showQueueError,
    snoozeQueueAlarm,
    stageDraft,
    startQueueRun,
    testQueueAlarm,
  ]);

  const screenProps = { state, dispatch: uiDispatch, adapter, batchStartPending };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="ambient ambient--crimson" aria-hidden="true" />
      <div className="ambient ambient--cobalt" aria-hidden="true" />
      <TopBar state={state} dispatch={uiDispatch} />

      <StudioCoordination stop={state.studio.stop} dispatch={uiDispatch} />
      <GpuSwitchConsent
        request={gpuSwitchSnapshot?.record !== null && gpuSwitchSnapshot?.record !== undefined
          && state.studio.gpuSwitch?.isRequester
          ? null
          : state.studio.gpuSwitch}
        dispatch={uiDispatch}
      />
      {gpuSwitchSnapshot?.record !== null && gpuSwitchSnapshot?.record !== undefined ? (
        <GpuSwitchProgress
          snapshot={gpuSwitchSnapshot}
          workerRequest={state.studio.gpuSwitch}
          busyAction={gpuSwitchActionBusy}
          onAction={runGpuSwitchProgressAction}
        />
      ) : null}

      {gpuPriceAttention?.state === 'price_attention' ? (
        <aside className="duplicate-warning" role="alert" aria-live="assertive">
          <AlertTriangle size={18} />
          <div>
            <strong>{gpuPriceAttention.actualHourlyPriceMicroUsd === null
              ? 'Actual GPU price is unavailable'
              : 'Actual GPU price needs confirmation'}</strong>
            <span>
              {gpuPriceAttention.actualHourlyPriceMicroUsd === null
                ? 'The created Pod remains visible and stoppable, but generation is blocked because RunPod did not return a valid exact price.'
                : `Confirmed ${formatHourlyMicroUsdV1(gpuPriceAttention.confirmedHourlyPriceMicroUsd)} · actual ${formatHourlyMicroUsdV1(gpuPriceAttention.actualHourlyPriceMicroUsd)}. Accepting uses a second native paid-action confirmation.`}
            </span>
          </div>
          {gpuPriceAttention.actualHourlyPriceMicroUsd === null ? (
            <Button compact tone="secondary" onClick={() => dispatch({ type: 'NAVIGATE', view: 'settings' })}>
              Review GPU controls
            </Button>
          ) : (
            <Button compact tone="primary" pending={gpuPriceConfirmBusy} disabled={gpuPriceConfirmBusy} onClick={confirmGpuPriceAttention}>
              Accept actual price
            </Button>
          )}
        </aside>
      ) : null}

      {state.pod.matchingPodIds.length > 1 ? (
        <aside className="duplicate-warning" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>{state.pod.matchingPodIds.length} ImageForge Pods are accruing hourly cost</strong>
            <span>{state.pod.matchingPodIds.join(' · ')}. ImageForge will never terminate either automatically.</span>
          </div>
          <Button compact tone="secondary" onClick={() => dispatch({ type: 'NAVIGATE', view: 'settings' })}>Review Pods</Button>
        </aside>
      ) : null}

      {state.pod.createRecovery ? (
        <aside className="duplicate-warning" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>Interrupted RunPod start needs reconciliation</strong>
            <span>No additional GPU can start. ImageForge is looking for {state.pod.createRecovery.podName ?? 'the exact attempted Pod'} without guessing.</span>
          </div>
          <Button compact tone="secondary" onClick={() => uiDispatch({ type: 'REQUEST_RESOLVE_CREATE' })}>Resolve start</Button>
        </aside>
      ) : null}

      {state.localSyncIssue ? (
        <aside className="local-sync-warning" role="alert" aria-live="polite">
          <AlertTriangle size={18} />
          <div>
            <strong>Local files need attention</strong>
            <span>{state.localSyncIssue.message} Shared GPU and batch status will keep updating.</span>
          </div>
          <Button compact tone="secondary" onClick={() => dispatch({ type: 'NAVIGATE', view: 'settings' })}>Open settings</Button>
        </aside>
      ) : null}

      {gpuSwitchLoadState === 'error' ? (
        <aside className="local-sync-warning" role="alert" aria-live="assertive">
          <AlertTriangle size={18} />
          <div>
            <strong>GPU switch recovery is paused</strong>
            <span>
              The durable Switch journal could not be verified. Start, Stop, and replacement stay blocked.
            </span>
          </div>
        </aside>
      ) : null}

      <main id="main-content" className="page-stage" tabIndex={-1}>
        {state.activeView === 'create' ? <CreateScreen {...screenProps} /> : null}
        {state.activeView === 'progress' ? <ProgressScreen {...screenProps} /> : null}
        {state.activeView === 'library' ? <LibraryScreen {...screenProps} /> : null}
        {state.activeView === 'usage' ? <UsageScreen {...screenProps} /> : null}
        {state.activeView === 'settings' ? <SettingsScreen {...screenProps} /> : null}
      </main>

      {gpuSelectorOpen ? (
        gpuSelectorError !== null ? (
          <section className="gpu-selector" role="dialog" aria-labelledby="gpu-selector-error-title">
            <header className="gpu-selector__header">
              <div>
                <p className="gpu-selector__eyebrow">Secure Cloud · EU-RO-1 · one GPU</p>
                <h2 id="gpu-selector-error-title">
                  {gpuSelectorError.code.startsWith('credential_')
                    ? 'RunPod credential needs attention'
                    : 'GPU inventory unavailable'}
                </h2>
                <p role="alert">{gpuSelectorError.message}</p>
              </div>
              <Button tone="secondary" onClick={closeGpuSelector}>Close</Button>
            </header>
            <footer className="gpu-selector__footer">
              <span>No Pod was started. A fresh native inventory receipt is required.</span>
              <Button
                tone="primary"
                pending={gpuSelectorBusy}
                onClick={() => {
                  if (gpuSelectorError.code.startsWith('credential_')) {
                    closeGpuSelector();
                    dispatch({ type: 'NAVIGATE', view: 'settings' });
                  } else {
                    void prepareGpuSelector(false);
                  }
                }}
              >
                {gpuSelectorError.code.startsWith('credential_') ? 'Open settings' : 'Retry GPU list'}
              </Button>
            </footer>
          </section>
        ) : gpuSelectorSnapshot === null ? (
          <section className="gpu-selector" role="dialog" aria-labelledby="gpu-selector-loading-title">
            <header className="gpu-selector__header">
              <div>
                <p className="gpu-selector__eyebrow">Secure Cloud · EU-RO-1 · one GPU</p>
                <h2 id="gpu-selector-loading-title">Choose a GPU</h2>
                <p>Loading the native inventory journal…</p>
              </div>
              <Button tone="secondary" onClick={closeGpuSelector}>Close</Button>
            </header>
          </section>
        ) : (
          <GpuSelector
            snapshot={gpuSelectorSnapshot}
            mode={gpuSelectorMode}
            busy={gpuSelectorBusy}
            returnFocusRef={gpuSelectorReturnFocusRef}
            onClose={closeGpuSelector}
            onRefresh={() => { void prepareGpuSelector(false); }}
            onCommit={commitGpuSelectorChoice}
            onConfirmationOpenChange={setGpuSelectorConfirming}
          />
        )
      ) : null}

      <BottomNav state={state} dispatch={uiDispatch} />

      {state.dialog ? (
        <DialogPortal
          backdropClassName="modal-backdrop"
          surfaceClassName="modal"
          role="alertdialog"
          labelledBy="modal-title"
          onRequestClose={() => dispatch({ type: 'DISMISS_DIALOG' })}
        >
            <IconButton label="Close confirmation" icon={X} className="modal__close" onClick={() => dispatch({ type: 'DISMISS_DIALOG' })} />
            <span className="modal__symbol"><AlertTriangle size={23} /></span>
            {state.dialog.type === 'stop-pod' ? (
              <>
                <p className="eyebrow">Explicit termination</p>
                <h2 id="modal-title">Request a coordinated GPU stop?</h2>
                <p>
                  ImageForge checks the durable batch lease, revalidates the exact GPU, then terminates it. No other editor is asked.
                </p>
                <div className="modal__notice">
                  <strong>Confirmed target:</strong> {state.dialog.podId} · {state.pod.gpu ?? 'GPU unknown'} · {state.pod.hourlyRate === null ? 'rate unavailable' : `$${state.pod.hourlyRate.toFixed(2)}/hr`}
                </div>
                <div className="modal__notice">
                  A batch that is still generating blocks this unconditionally. Cancel the batch first, then stop the GPU.
                </div>
                <div className="modal__notice">
                  ImageForge has no idle timer and never stops compute on completion, app exit, or connection loss. Network volume data and downloaded images remain.
                </div>
                <div className="modal__actions">
                  <Button data-autofocus onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Keep GPU running</Button>
                  <Button tone="danger" onClick={() => uiDispatch({ type: 'CONFIRM_STOP_POD' })}>Stop GPU</Button>
                </div>
              </>
            ) : state.dialog.type === 'resolve-create' ? (
              <>
                <p className="eyebrow">Interrupted GPU start</p>
                <h2 id="modal-title">Confirm that no matching Pod exists</h2>
                <p>
                  Check RunPod for <strong>{state.pod.createRecovery?.podName ?? 'the attempted ImageForge Pod'}</strong>. Continue only if that exact Pod was not created or is no longer active.
                </p>
                <div className="modal__notice">
                  ImageForge blocks every additional paid start until this marker is reconciled. It never guesses after an uncertain create response.
                </div>
                <div className="modal__actions">
                  <Button data-autofocus onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Keep blocked</Button>
                  <Button tone="danger" onClick={() => uiDispatch({ type: 'CONFIRM_RESOLVE_CREATE' })}>I confirmed no Pod exists</Button>
                </div>
              </>
            ) : state.dialog.type === 'reset-queue' ? (
              <>
                <p className="eyebrow">Local queue recovery</p>
                <h2 id="modal-title">Reset the unrecoverable local queue?</h2>
                <p>
                  ImageForge will quarantine the existing private queue store and create an empty one. This does not delete downloaded images, stop the GPU, or change a remote batch.
                </p>
                <div className="modal__notice">
                  Use this only after reviewing the recovery warning. Staged queue rows must be created again from their original briefs.
                </div>
                <div className="modal__actions">
                  <Button data-autofocus onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Keep queue files</Button>
                  <Button tone="danger" onClick={() => uiDispatch({ type: 'CONFIRM_RESET_QUEUE' })}>Reset local queue</Button>
                </div>
              </>
            ) : state.dialog.type === 'cancel-batch' ? (
              <>
                <p className="eyebrow">Cancel batch</p>
                <h2 id="modal-title">Stop generating remaining images?</h2>
                <p>Images already saved stay in the selected folder. Unfinished prompts are removed from this run so a new batch can start.</p>
                <div className="modal__actions">
                  <Button data-autofocus onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Continue batch</Button>
                  <Button tone="danger" onClick={() => uiDispatch({ type: 'CONFIRM_CANCEL_BATCH' })}>Cancel remaining</Button>
                </div>
              </>
            ) : (
              <>
                <p className="eyebrow">Local library index</p>
                <h2 id="modal-title">Clear library history?</h2>
                <p>This clears the in-app index only. ImageForge will not delete source JPEGs from your destination folder.</p>
                <div className="modal__actions">
                  <Button data-autofocus onClick={() => dispatch({ type: 'DISMISS_DIALOG' })}>Keep history</Button>
                  <Button tone="danger" onClick={() => dispatch({ type: 'CLEAR_LIBRARY' })}>Clear index</Button>
                </div>
              </>
            )}
        </DialogPortal>
      ) : null}

      {state.toast ? (
        <div className={`toast toast--${state.toast.tone}`} role="status" aria-live="polite">
          {state.toast.tone === 'success' ? <CheckCircle2 size={19} /> : state.toast.tone === 'error' ? <XCircle size={19} /> : state.toast.tone === 'warning' ? <AlertTriangle size={19} /> : <Info size={19} />}
          <div><strong>{state.toast.title}</strong><span>{state.toast.message}</span></div>
          {state.toast.action ? <Button compact tone="secondary" onClick={() => { dispatch({ type: 'NAVIGATE', view: state.toast!.action!.view }); dispatch({ type: 'DISMISS_TOAST' }); }}>{state.toast.action.label}</Button> : null}
          <IconButton label="Dismiss notification" icon={X} onClick={() => dispatch({ type: 'DISMISS_TOAST' })} />
        </div>
      ) : null}

      {!state.setup.completed ? (
        <SetupAssistant state={state} dispatch={dispatch} adapter={adapter} canClose={false} />
      ) : null}
    </div>
  );
}
