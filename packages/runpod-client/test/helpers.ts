import type {
  BenchmarkContract,
  GpuOffer,
  ManagedPod,
  RunPodClientConfig,
} from "../src/index.js";
import { createRunPodClientConfig, deriveRunPodProxyUrl } from "../src/index.js";

export const benchmarkContract: BenchmarkContract = Object.freeze({
  model: "black-forest-labs/FLUX.2-klein-4B",
  modelRevision: "0123456789abcdef",
  softwareImage: "ghcr.io/imageforge/worker@sha256:0123456789abcdef",
  precision: "BF16",
  width: 1280,
  height: 720,
  steps: 4,
  guidance: 1,
  jpegQuality: 95,
});

export function makeConfig(
  overrides: Partial<RunPodClientConfig> = {},
): RunPodClientConfig {
  return createRunPodClientConfig({
    templateId: "template1",
    networkVolumeId: "volume1",
    networkVolumeDataCenterId: "EU-RO-1",
    benchmarkContract,
    ...overrides,
  });
}

export function makeOffer(overrides: Partial<GpuOffer> = {}): GpuOffer {
  return Object.freeze({
    gpuId: "NVIDIA GeForce RTX 4090",
    policyKey: "rtx_4090",
    coldPriority: 0,
    emergency: false,
    displayName: "RTX 4090",
    cloud: "secure",
    hourlyPriceUsd: 0.5,
    availability: "high",
    dataCenterId: "EU-RO-1",
    volumeCompatible: true,
    observedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
}

export function makePod(overrides: Partial<ManagedPod> = {}): ManagedPod {
  const id = overrides.id ?? "podold1";
  return Object.freeze({
    id,
    name: "imageforge-existing",
    status: "running",
    gpuId: "NVIDIA GeForce RTX 4090",
    cloud: "secure",
    templateId: "template1",
    networkVolumeId: "volume1",
    hourlyPriceUsd: 0.5,
    createdAt: "2026-08-01T00:00:00.000Z",
    startRequestId: "existing",
    proxyUrl: deriveRunPodProxyUrl(id, 8000),
    ...overrides,
  });
}
