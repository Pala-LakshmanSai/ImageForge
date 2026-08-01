import { parseStudioProfile } from './imageForgeAdapter';
import type { AppState, SettingsState } from '../domain/types';

const STORAGE_KEY = 'imageforge.safe-preferences.v1';

interface SafePreferencesV1 {
  version: 1;
  setupCompleted: true;
  userName: string;
  defaultDestination: string;
  editorialSuffixEnabled: boolean;
  editorialSuffix: string;
  theme: SettingsState['theme'];
  density: SettingsState['density'];
  gpuPreference: SettingsState['gpuPreference'];
  studioProfile: string;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length <= maximum ? value : null;
}

function parse(value: unknown): SafePreferencesV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const allowed = new Set([
    'version',
    'setupCompleted',
    'userName',
    'defaultDestination',
    'editorialSuffixEnabled',
    'editorialSuffix',
    'theme',
    'density',
    'gpuPreference',
    'studioProfile',
  ]);
  if (
    Object.keys(item).some((key) => !allowed.has(key)) ||
    item.version !== 1 ||
    item.setupCompleted !== true
  ) return null;
  const userName = boundedString(item.userName, 80);
  const destination = boundedString(item.defaultDestination, 2_048);
  const suffix = boundedString(item.editorialSuffix, 2_000);
  const studioProfile = boundedString(item.studioProfile, 4_096);
  if (
    userName === null ||
    destination === null ||
    suffix === null ||
    studioProfile === null ||
    typeof item.editorialSuffixEnabled !== 'boolean' ||
    !['midnight', 'ink'].includes(String(item.theme)) ||
    !['comfortable', 'compact'].includes(String(item.density)) ||
    !['best_value', 'fastest'].includes(String(item.gpuPreference)) ||
    parseStudioProfile(studioProfile) === null
  ) return null;
  return {
    version: 1,
    setupCompleted: true,
    userName,
    defaultDestination: destination,
    editorialSuffixEnabled: item.editorialSuffixEnabled,
    editorialSuffix: suffix,
    theme: item.theme as SettingsState['theme'],
    density: item.density as SettingsState['density'],
    gpuPreference: item.gpuPreference as SettingsState['gpuPreference'],
    studioProfile,
  };
}

export function hydrateSafePreferences(base: AppState, storage: Pick<Storage, 'getItem'>): AppState {
  let persisted: SafePreferencesV1 | null = null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    persisted = raw === null || raw.length > 32_768 ? null : parse(JSON.parse(raw) as unknown);
  } catch {
    persisted = null;
  }
  if (persisted === null) return base;
  return {
    ...base,
    settings: {
      ...base.settings,
      userName: persisted.userName,
      defaultDestination: persisted.defaultDestination,
      editorialSuffixEnabled: persisted.editorialSuffixEnabled,
      editorialSuffix: persisted.editorialSuffix,
      theme: persisted.theme,
      density: persisted.density,
      gpuPreference: persisted.gpuPreference,
      // Emergency capacity is a foreground decision for one explicit Start.
      slowEmergencyGpuEnabled: false,
      simulationSpeed: 1,
    },
    setup: {
      ...base.setup,
      studioProfile: persisted.studioProfile,
      completed: true,
      destinationValidated: false,
    },
    draft: {
      ...base.draft,
      destination: persisted.defaultDestination || null,
    },
  };
}

export function persistSafePreferences(state: AppState, storage: Pick<Storage, 'setItem'>): void {
  const preferences: SafePreferencesV1 = {
    version: 1,
    setupCompleted: true,
    userName: state.settings.userName.slice(0, 80),
    defaultDestination: state.settings.defaultDestination.slice(0, 2_048),
    editorialSuffixEnabled: state.settings.editorialSuffixEnabled,
    editorialSuffix: state.settings.editorialSuffix.slice(0, 2_000),
    theme: state.settings.theme,
    density: state.settings.density,
    gpuPreference: state.settings.gpuPreference,
    studioProfile: state.setup.studioProfile,
  };
  // The schema deliberately has no credential values, credential metadata,
  // Pod identifiers, prompt text, manifests, receipts, or diagnostic bodies.
  storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export const SAFE_PREFERENCES_STORAGE_KEY = STORAGE_KEY;
