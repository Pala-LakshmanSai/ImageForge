import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createProductionImageForgeAdapter } from './adapters/productionImageForgeAdapter';
import { hydrateSafePreferences, readPersistedBatchRecovery } from './adapters/safePreferences';
import { createConfiguredInitialState, createInitialState } from './domain/reducer';
import { createNativeProductionPort } from './native/productionPort';
import { isNativeDesktop } from './native/tauriBridge';
import { runNativeSmoke } from './native/nativeSmoke';
import { GpuSelectorPerfSmoke } from './native/gpuSelectorPerfSmoke';
import {
  QueueReleaseSmokeController,
  QueueReleaseSmokeHarness,
  runQueueReleaseSmoke,
} from './native/queueReleaseSmoke';
import { runTwoClientNativeSmoke } from './native/twoClientNativeSmoke';
import { createTwoClientSmokePort, type TwoClientSmokeRole } from './native/twoClientSmokePort';

const native = isNativeDesktop();
const queueReleaseSmoke = native && window.__IMAGEFORGE_QUEUE_RELEASE_SMOKE__ === true;
const selectorPerfSmoke = native && !queueReleaseSmoke && window.__IMAGEFORGE_GPU_SELECTOR_PERF_QA__ === true;
const nativeSmoke = native && !queueReleaseSmoke && !selectorPerfSmoke && window.__IMAGEFORGE_NATIVE_SMOKE__ === true;
const twoClientRole = nativeSmoke && ['A', 'B'].includes(window.__IMAGEFORGE_NATIVE_SMOKE_ROLE__ ?? '')
  ? window.__IMAGEFORGE_NATIVE_SMOKE_ROLE__ as TwoClientSmokeRole
  : null;
const twoClientFixture = twoClientRole === null ? null : createTwoClientSmokePort(twoClientRole);
const twoClientInitialState = twoClientRole === null ? undefined : createConfiguredInitialState();
if (twoClientInitialState && twoClientRole === 'B') {
  twoClientInitialState.settings = { ...twoClientInitialState.settings, userName: 'Sujal' };
}
const initialState = twoClientInitialState ?? (native && !nativeSmoke && !selectorPerfSmoke
  ? hydrateSafePreferences(createInitialState(), window.localStorage)
  : undefined);
const recoveredBatch = native && !nativeSmoke && !selectorPerfSmoke
  ? readPersistedBatchRecovery(window.localStorage)
  : null;
const adapter = twoClientFixture !== null
  ? createProductionImageForgeAdapter(
      twoClientFixture.port,
      twoClientRole === 'B' ? '11111111-1111-4111-8111-111111111111' : null,
      twoClientRole === 'B' ? 'Stale local recovery' : null,
    )
  : native && !nativeSmoke && !selectorPerfSmoke
  ? createProductionImageForgeAdapter(
      createNativeProductionPort(),
      recoveredBatch?.id ?? null,
      recoveredBatch?.name ?? null,
    )
  : undefined;
const queueReleaseController = queueReleaseSmoke ? new QueueReleaseSmokeController() : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {selectorPerfSmoke
      ? <GpuSelectorPerfSmoke />
      : queueReleaseController
      ? <QueueReleaseSmokeHarness controller={queueReleaseController} />
      : <App initialState={initialState} adapter={adapter} />}
  </StrictMode>,
);

if (queueReleaseController !== null) {
  window.setTimeout(() => void runQueueReleaseSmoke(queueReleaseController), 900);
} else if (twoClientRole !== null && twoClientFixture !== null && adapter?.runtime) {
  window.setTimeout(
    () => void runTwoClientNativeSmoke(twoClientRole, adapter.runtime!, twoClientFixture),
    1_200,
  );
} else if (nativeSmoke) {
  window.setTimeout(() => void runNativeSmoke(), 900);
}
