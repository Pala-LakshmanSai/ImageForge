import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  RunPodClientError,
  FakeRunPodProvider,
  GPU_POLICY,
  RunPodLifecycleController,
  approveCatalogGpu,
  createRunPodClientConfig,
  staticGpuPolicy,
  type RunPodClientConfig,
  type RunPodClientConfigInput,
} from "../src/index.js";
import { benchmarkContract, makeConfig } from "./helpers.js";

describe("RunPod studio configuration", () => {
  it("deep-validates fully populated imported profiles instead of trusting their shape", () => {
    const fullyPopulated = {
      templateId: "template1",
      networkVolumeId: "volume1",
      networkVolumeDataCenterId: "US-TX-1",
      networkVolumeMountPath: "/workspace",
      podNamePrefix: "imageforge",
      workerPort: 8000,
      gpuCount: 1,
      cloudLanes: ["community"] as const,
      allowEmergencyGpuTier: false,
      defaultImageCount: 450,
      refreshIntervalMs: 1000,
      provisioningTimeoutMs: 1200000,
      operationTimeoutMs: 30000,
      stopConfirmationTtlMs: 120000,
      constraints: { allowedCudaVersions: ["13.0"], minRamPerGpuGb: 16 },
      benchmarkContract,
      benchmarkProfiles: [],
    };

    assert.throws(
      () =>
        createRunPodClientConfig(
          fullyPopulated as unknown as RunPodClientConfigInput,
        ),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "configuration_invalid",
    );
  });

  it("rejects malformed nested JSON values and unsupported fields with typed errors", () => {
    const valid = {
      templateId: "template1",
      networkVolumeId: "volume1",
      networkVolumeDataCenterId: "EU-RO-1",
      networkVolumeMountPath: "/workspace",
      podNamePrefix: "imageforge",
      workerPort: 8000,
      gpuCount: 1,
      cloudLanes: ["secure"],
      allowEmergencyGpuTier: false,
      defaultImageCount: 450,
      refreshIntervalMs: 1000,
      provisioningTimeoutMs: 1200000,
      operationTimeoutMs: 30000,
      stopConfirmationTtlMs: 120000,
      constraints: { allowedCudaVersions: ["13.0"], minRamPerGpuGb: 16 },
      benchmarkContract,
      benchmarkProfiles: [],
    };
    const invalidProfiles: readonly unknown[] = [
      { ...valid, allowEmergencyGpuTier: "false" },
      { ...valid, constraints: null },
      { ...valid, constraints: { ...valid.constraints, unknownConstraint: 1 } },
      { ...valid, benchmarkContract: { ...benchmarkContract, modelRevision: 7 } },
      { ...valid, benchmarkProfiles: {} },
      {
        ...valid,
        benchmarkProfiles: [
          {
            gpuId: "NVIDIA GeForce RTX 4090",
            measuredAt: "1",
            promptSampleSize: 30,
            bootSeconds: 300,
            secondsPerImage: 5,
            contract: benchmarkContract,
          },
        ],
      },
      {
        ...valid,
        benchmarkProfiles: [
          {
            gpuId: "NVIDIA GeForce RTX 4090",
            measuredAt: "2026-01-01",
            promptSampleSize: 30,
            bootSeconds: 300,
            secondsPerImage: 5,
            contract: benchmarkContract,
          },
        ],
      },
      { ...valid, networkVolumeMountPath: "/workspace/.." },
      { ...valid, networkVolumeMountPath: "/.." },
      { ...valid, networkVolumeMountPath: "/workspace/." },
      { ...valid, operationTimeoutMs: 99 },
      { ...valid, operationTimeoutMs: 120001 },
      { ...valid, unexpectedTopLevel: true },
    ];

    for (const invalid of invalidProfiles) {
      assert.throws(
        () =>
          createRunPodClientConfig(
            invalid as RunPodClientConfigInput,
          ),
        (error: unknown) =>
          error instanceof RunPodClientError && error.code === "configuration_invalid",
      );
    }
  });

  it("revalidates forged RunPodClientConfig objects at the controller boundary", () => {
    const forged = {
      ...makeConfig(),
      networkVolumeDataCenterId: "US-TX-1",
    } as unknown as RunPodClientConfig;

    assert.throws(
      () =>
        new RunPodLifecycleController({
          provider: new FakeRunPodProvider(),
          config: forged,
        }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "configuration_invalid",
    );
  });

  it("pins and deeply freezes the Secure EU-RO-1 one-GPU CUDA 13 profile", () => {
    const config = createRunPodClientConfig({
      templateId: "template1",
      networkVolumeId: "volume1",
      networkVolumeDataCenterId: "EU-RO-1",
      benchmarkContract,
    });

    assert.equal(config.workerPort, 8000);
    assert.equal(config.gpuCount, 1);
    assert.equal(config.operationTimeoutMs, 30_000);
    assert.deepEqual(config.cloudLanes, ["secure"]);
    assert.deepEqual(config.constraints.allowedCudaVersions, ["13.0"]);
    assert.equal(config.constraints.minRamPerGpuGb, 16);
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.cloudLanes));
    assert.ok(Object.isFrozen(config.constraints));
    assert.ok(Object.isFrozen(config.constraints.allowedCudaVersions));
    assert.ok(Object.isFrozen(config.benchmarkContract));
    assert.ok(Object.isFrozen(config.benchmarkProfiles));
  });

  it("keeps the checked-in JSON schema aligned with the fixed runtime profile", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../../config/imageforge-runpod.schema.json", import.meta.url),
        "utf8",
      ),
    ) as {
      readonly properties: {
        readonly networkVolumeDataCenterId: { readonly const: unknown };
        readonly workerPort: { readonly const: unknown };
        readonly gpuCount: { readonly const: unknown };
        readonly cloudLanes: { readonly items: { readonly const: unknown } };
        readonly networkVolumeMountPath: { readonly pattern: string };
        readonly operationTimeoutMs: {
          readonly minimum: number;
          readonly maximum: number;
          readonly default: number;
        };
      };
      readonly $defs: {
        readonly constraints: {
          readonly properties: {
            readonly allowedCudaVersions: {
              readonly items: { readonly const: unknown };
            };
          };
        };
      };
    };

    assert.equal(schema.properties.networkVolumeDataCenterId.const, "EU-RO-1");
    assert.equal(schema.properties.workerPort.const, 8000);
    assert.equal(schema.properties.gpuCount.const, 1);
    assert.equal(schema.properties.cloudLanes.items.const, "secure");
    assert.deepEqual(schema.properties.operationTimeoutMs, {
      type: "integer",
      minimum: 100,
      maximum: 120000,
      default: 30000,
    });
    const mountPattern = new RegExp(schema.properties.networkVolumeMountPath.pattern);
    assert.equal(mountPattern.test("/workspace"), true);
    assert.equal(mountPattern.test("/workspace/models"), true);
    assert.equal(mountPattern.test("/workspace/.."), false);
    assert.equal(mountPattern.test("/.."), false);
    assert.equal(
      schema.$defs.constraints.properties.allowedCudaVersions.items.const,
      "13.0",
    );
  });
});

describe("EU-RO-1 GPU policy", () => {
  it("uses exact IDs for static GPUs and display-name pass-through only for dynamic Blackwell", () => {
    assert.deepEqual(
      GPU_POLICY.filter((entry) => !entry.emergency).map((entry) => entry.key),
      [
        "rtx_4090",
        "rtx_pro_4500_blackwell",
        "rtx_5090",
        "rtx_pro_4000_blackwell",
        "l4",
        "rtx_a4500",
        "rtx_4000_ada",
      ],
    );
    assert.equal(
      approveCatalogGpu(
        { id: "unapproved-4090-id", name: "RTX 4090", manufacturer: "NVIDIA", memoryGb: 24 },
        false,
      ),
      null,
    );
    assert.equal(
      approveCatalogGpu(
        {
          id: "NVIDIA B200",
          name: "RTX PRO 4500 Blackwell",
          manufacturer: "NVIDIA",
          memoryGb: 32,
        },
        false,
      ),
      null,
    );
    assert.deepEqual(
      approveCatalogGpu(
        {
          id: "catalog-pro-4500-v1",
          name: "RTX PRO 4500 Blackwell",
          manufacturer: "NVIDIA",
          memoryGb: 32,
        },
        false,
      )?.gpuId,
      "catalog-pro-4500-v1",
    );
    assert.equal(
      approveCatalogGpu(
        {
          id: "catalog-pro-4500-small",
          name: "RTX PRO 4500 Blackwell",
          manufacturer: "NVIDIA",
          memoryGb: 8,
        },
        false,
      ),
      null,
    );
  });

  it("allows only RTX 2000 Ada behind emergency opt-in", () => {
    const emergency = {
      id: "NVIDIA RTX 2000 Ada Generation",
      name: "RTX 2000 Ada",
      manufacturer: "NVIDIA",
      memoryGb: 16,
    };
    assert.equal(approveCatalogGpu(emergency, false), null);
    assert.equal(approveCatalogGpu(emergency, true)?.emergency, true);
    for (const removedId of ["NVIDIA A40", "NVIDIA RTX A6000", "NVIDIA L40", "NVIDIA L40S", "NVIDIA B200"]) {
      assert.equal(
        approveCatalogGpu(
          { id: removedId, name: removedId.replace(/^NVIDIA /, ""), manufacturer: "NVIDIA", memoryGb: 24 },
          true,
        ),
        null,
      );
    }
    assert.deepEqual(
      staticGpuPolicy(true).filter((entry) => entry.emergency).map((entry) => entry.gpuId),
      ["NVIDIA RTX 2000 Ada Generation"],
    );
    assert.ok(Object.isFrozen(GPU_POLICY));
    assert.ok(GPU_POLICY.every((entry) => Object.isFrozen(entry)));
    assert.ok(GPU_POLICY.every((entry) => Object.isFrozen(entry.catalogNames)));
    assert.ok(GPU_POLICY.every((entry) => Object.isFrozen(entry.exactIds)));
  });
});
