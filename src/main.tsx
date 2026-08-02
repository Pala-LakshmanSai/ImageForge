import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createProductionImageForgeAdapter } from './adapters/productionImageForgeAdapter';
import { hydrateSafePreferences, readPersistedBatchRecovery } from './adapters/safePreferences';
import { createInitialState } from './domain/reducer';
import { createNativeProductionPort } from './native/productionPort';
import { isNativeDesktop } from './native/tauriBridge';
import { runNativeSmoke } from './native/nativeSmoke';

const native = isNativeDesktop();
const nativeSmoke = native && window.__IMAGEFORGE_NATIVE_SMOKE__ === true;
const initialState = native && !nativeSmoke
  ? hydrateSafePreferences(createInitialState(), window.localStorage)
  : undefined;
const recoveredBatch = native && !nativeSmoke
  ? readPersistedBatchRecovery(window.localStorage)
  : null;
const adapter = native && !nativeSmoke
  ? createProductionImageForgeAdapter(
      createNativeProductionPort(),
      recoveredBatch?.id ?? null,
      recoveredBatch?.name ?? null,
    )
  : undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialState={initialState} adapter={adapter} />
  </StrictMode>,
);

if (nativeSmoke) {
  window.setTimeout(() => void runNativeSmoke(), 900);
}
