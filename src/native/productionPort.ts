import type { CredentialKind, CredentialMetadata, CredentialMetadataMap } from '../domain/types';
import type { ProductionDesktopPort } from '../adapters/productionImageForgeAdapter';
import {
  bindNativeRunPodProfile,
  bindNativeWorkerSession,
  clearNativeWorkerSession,
  nativeAuthorizeRunPodStart,
  nativeChooseDestination,
  nativeClearRunPodStartAuthorization,
  nativeCredentialMetadata,
  nativeDownloadArtifact,
  nativeReconcileReceipts,
  nativeReplaceCredential,
  nativeRestoreDestination,
  nativeResolveRunPodCreateMarker,
  nativeRunPodCreateMarkerMetadata,
  nativeRunPodFetch,
  nativeValidateDestination,
  nativeWorkerCreateBatch,
  nativeWorkerGetBatch,
  nativeWorkerHealthFetch,
  nativeWorkerPauseBatch,
  nativeWorkerCancelBatch,
  nativeWorkerResumeBatch,
  nativeWorkerRetryFailed,
  nativeWorkerStatus,
} from './tauriBridge';

/** Narrow renderer-side composition of the native commands. No secret or
 * arbitrary URL/path crosses this boundary. */
export function createNativeProductionPort(): ProductionDesktopPort {
  let boundDestination: { path: string; writable: true } | null = null;

  async function validateDestination(path: string) {
    if (boundDestination?.path === path) return boundDestination;
    const restored = await nativeRestoreDestination();
    if (restored?.path === path && restored.writable) {
      boundDestination = { path: restored.path, writable: true };
      return boundDestination;
    }
    throw new Error('Choose and verify a writable ImageForge downloads folder.');
  }

  return {
    runPodFetch: nativeRunPodFetch,
    workerHealthFetch: nativeWorkerHealthFetch,
    bindProfile: bindNativeRunPodProfile,
    authorizeStart: nativeAuthorizeRunPodStart,
    clearStartAuthorization: nativeClearRunPodStartAuthorization,
    clearWorkerSession: clearNativeWorkerSession,
    createMarkerMetadata: nativeRunPodCreateMarkerMetadata,
    resolveCreateMarker: nativeResolveRunPodCreateMarker,
    chooseDestination: async (defaultPath) => {
      const selection = await nativeChooseDestination(defaultPath);
      if (selection === null) return null;
      const validated = await nativeValidateDestination(selection.path, selection.chooserGrant);
      if (!validated.writable) throw new Error('The selected folder is not writable.');
      boundDestination = { path: validated.path, writable: true };
      return boundDestination;
    },
    validateDestination,
    credentialMetadata: nativeCredentialMetadata,
    replaceCredential: (kind: CredentialKind, value: string): Promise<CredentialMetadata> =>
      nativeReplaceCredential(kind, value),
    status: nativeWorkerStatus,
    createBatch: nativeWorkerCreateBatch,
    getBatch: nativeWorkerGetBatch,
    pauseBatch: nativeWorkerPauseBatch,
    resumeBatch: nativeWorkerResumeBatch,
    cancelBatch: nativeWorkerCancelBatch,
    retryFailed: nativeWorkerRetryFailed,
    readReceipts: async (batchId) => (await nativeReconcileReceipts(batchId)).receipts,
    downloadArtifact: nativeDownloadArtifact,
  };
}
