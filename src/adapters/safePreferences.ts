import { parseStudioProfile } from './imageForgeAdapter';
import type { AppState, SettingsState } from '../domain/types';

const STORAGE_KEY = 'imageforge.safe-preferences.v1';

interface SafePreferences {
  version: 1 | 2;
  setupCompleted: true;
  lastOwnedBatchId: string | null;
  lastOwnedBatchName: string | null;
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

const BATCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parse(value: unknown): SafePreferences | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const allowed = new Set([
    'version',
    'setupCompleted',
    'lastOwnedBatchId',
    'lastOwnedBatchName',
    'userName',
    'defaultDestination',
    'editorialSuffixEnabled',
    'editorialSuffix',
    'theme',
    'density',
    'gpuPreference',
    'studioProfile',
  ]);
  const rawBatchId = item.lastOwnedBatchId === undefined || item.lastOwnedBatchId === null
    ? null
    : boundedString(item.lastOwnedBatchId, 80);
  const lastOwnedBatchId = rawBatchId === null || BATCH_ID_PATTERN.test(rawBatchId) ? rawBatchId : null;
  const validVersion = item.version === 1 || item.version === 2;
  const lastOwnedBatchName = item.version === 2 && item.lastOwnedBatchName !== null
    ? boundedString(item.lastOwnedBatchName, 80)
    : null;
  if (
    Object.keys(item).some((key) => !allowed.has(key)) ||
    !validVersion ||
    item.setupCompleted !== true
    || (item.lastOwnedBatchId !== undefined && item.lastOwnedBatchId !== null && lastOwnedBatchId === null)
    || (item.version === 1 && item.lastOwnedBatchName !== undefined)
    || (item.version === 2 && (
      item.lastOwnedBatchName === undefined
      || (lastOwnedBatchId === null && item.lastOwnedBatchName !== null)
      || (lastOwnedBatchName !== null && !lastOwnedBatchName.trim())
    ))
  ) return null;
  const userName = boundedString(item.userName, 80);
  const destination = boundedString(item.defaultDestination, 2_048);
  // Suffix text is user-authored prompt content. Keep it bounded only by the
  // storage record's practical size limit rather than imposing a product cap.
  const suffix = typeof item.editorialSuffix === 'string' ? item.editorialSuffix : null;
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
    version: item.version as 1 | 2,
    setupCompleted: true,
    lastOwnedBatchId,
    lastOwnedBatchName,
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
  let persisted: SafePreferences | null = null;
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

export function persistSafePreferences(
  state: AppState,
  storage: Pick<Storage, 'setItem'>,
  recoveryOverride?: PersistedBatchRecovery | null,
): void {
  const activeRecovery = state.batch?.canManage === true && BATCH_ID_PATTERN.test(state.batch.id)
    ? { id: state.batch.id, name: state.batch.name.slice(0, 80) }
    : null;
  const recovery = recoveryOverride !== undefined ? recoveryOverride : activeRecovery;
  const preferences: SafePreferences = {
    version: 2,
    setupCompleted: true,
    lastOwnedBatchId: recovery?.id ?? null,
    lastOwnedBatchName: recovery?.name?.slice(0, 80) ?? null,
    userName: state.settings.userName.slice(0, 80),
    defaultDestination: state.settings.defaultDestination.slice(0, 2_048),
    editorialSuffixEnabled: state.settings.editorialSuffixEnabled,
    editorialSuffix: state.settings.editorialSuffix,
    theme: state.settings.theme,
    density: state.settings.density,
    gpuPreference: state.settings.gpuPreference,
    studioProfile: state.setup.studioProfile,
  };
  // The schema deliberately has no credential values, credential metadata,
  // Pod identifiers, prompt text, manifests, receipts, or diagnostic bodies.
  storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export interface PersistedBatchRecovery {
  id: string;
  name: string | null;
}

/** Recovery stores only the worker UUID and user-entered batch name. Prompt
 * text, image metadata, credentials, and Pod identity remain excluded. */
export function readPersistedBatchRecovery(
  storage: Pick<Storage, 'getItem'>,
): PersistedBatchRecovery | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null || raw.length > 32_768) return null;
    const persisted = parse(JSON.parse(raw) as unknown);
    return persisted?.lastOwnedBatchId
      ? { id: persisted.lastOwnedBatchId, name: persisted.lastOwnedBatchName }
      : null;
  } catch {
    return null;
  }
}

export function readPersistedBatchId(storage: Pick<Storage, 'getItem'>): string | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null || raw.length > 32_768) return null;
    return parse(JSON.parse(raw) as unknown)?.lastOwnedBatchId ?? null;
  } catch {
    return null;
  }
}

export const SAFE_PREFERENCES_STORAGE_KEY = STORAGE_KEY;
