import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createProductionImageForgeAdapter } from './adapters/productionImageForgeAdapter';
import { hydrateSafePreferences, readPersistedBatchId } from './adapters/safePreferences';
import { createInitialState } from './domain/reducer';
import { createNativeProductionPort } from './native/productionPort';
import { isNativeDesktop } from './native/tauriBridge';

const native = isNativeDesktop();
const initialState = native
  ? hydrateSafePreferences(createInitialState(), window.localStorage)
  : undefined;
const recoveredBatchId = native ? readPersistedBatchId(window.localStorage) : null;
const adapter = native ? createProductionImageForgeAdapter(createNativeProductionPort(), recoveredBatchId) : undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialState={initialState} adapter={adapter} />
  </StrictMode>,
);
