import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import {
  FakeWorkerHealthProbe,
  RunPodClientError,
  RunPodLifecycleController,
  RunPodRestProvider,
  RunPodV2InventorySource,
  type CreatePodFromTemplateRequest,
  type FetchTransport,
  type GpuInventorySource,
  type PodDiscoveryCriteria,
} from "../src/index.js";
import { makeConfig, makeOffer } from "./helpers.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const discoveryCriteria: PodDiscoveryCriteria = {
  podNamePrefix: "imageforge",
  templateId: "template1",
  networkVolumeId: "volume1",
  networkVolumeMountPath: "/workspace",
  workerPort: 8000,
  dataCenterId: "EU-RO-1",
  cloud: "secure",
  gpuCount: 1,
  interruptible: false,
  includeEmergencyGpuTier: false,
};

function validPodResponse(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "newpod1",
    name: "imageforge-request1",
    desiredStatus: "RUNNING",
    gpu: { id: "NVIDIA GeForce RTX 5090", displayName: "RTX 5090", count: 1 },
    templateId: "template1",
    interruptible: false,
    networkVolume: { id: "volume1", dataCenterId: "EU-RO-1" },
    volumeMountPath: "/workspace",
    machine: { secureCloud: true, dataCenterId: "EU-RO-1" },
    ports: ["8000/http"],
    adjustedCostPerHr: 0.5,
    costPerHr: "0.55",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("RunPodV2InventorySource", () => {
  it("joins exact EU-RO-1 stock, preserves dynamic catalog IDs, and filters the allowlist", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchTransport: FetchTransport = (async (input, init) => {
      const url = String(input);
      seen.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.includes("/catalog/datacenters")) {
        return jsonResponse({
          dataCenters: [
            {
              id: "EU-RO-1",
              name: "EU Romania 1",
              region: "EUROPE",
              globalNetwork: true,
              networkVolumeTypes: ["STANDARD"],
              compliance: ["GDPR"],
              gpuAvailability: [
                { id: "NVIDIA GeForce RTX 4090", name: "RTX 4090", availability: "HIGH" },
                {
                  id: "catalog-exact-pro4500-v1",
                  name: "RTX PRO 4500 Blackwell",
                  availability: "HIGH",
                },
                { id: "NVIDIA B200", name: "B200", availability: "HIGH" },
                {
                  id: "NVIDIA RTX 2000 Ada Generation",
                  name: "RTX 2000 Ada",
                  availability: "LOW",
                },
              ],
            },
          ],
        });
      }
      assert.match(url, /include=AVAILABILITY/);
      assert.match(url, /product=POD/);
      assert.match(url, /count=1/);
      assert.match(url, /cloud=SECURE/);
      assert.match(url, /minCudaVersion=13.0/);
      return jsonResponse({
        gpus: [
          {
            id: "NVIDIA GeForce RTX 4090",
            name: "RTX 4090",
            manufacturer: "NVIDIA",
            memory: 24,
            secure: true,
            community: true,
            price: { secure: 0.44, community: 0.31 },
            maxCount: { secure: 8, community: 4 },
            availability: "HIGH",
            dataCenters: [{ id: "EU-RO-1", name: "EU Romania 1", availability: "HIGH" }],
          },
          {
            id: "catalog-exact-pro4500-v1",
            name: "RTX PRO 4500 Blackwell",
            manufacturer: "NVIDIA",
            memory: 32,
            secure: true,
            community: false,
            price: { secure: 0.5, community: 0 },
            maxCount: { secure: 1, community: 0 },
            availability: "HIGH",
            dataCenters: [{ id: "EU-RO-1", name: "EU Romania 1", availability: "HIGH" }],
          },
          {
            id: "NVIDIA B200",
            name: "B200",
            manufacturer: "NVIDIA",
            memory: 180,
            secure: true,
            community: false,
            price: { secure: 3.5, community: 0 },
            maxCount: { secure: 8, community: 0 },
            availability: "HIGH",
            dataCenters: [{ id: "EU-RO-1", name: "EU Romania 1", availability: "HIGH" }],
          },
          {
            id: "NVIDIA RTX 2000 Ada Generation",
            name: "RTX 2000 Ada",
            manufacturer: "NVIDIA",
            memory: 16,
            secure: true,
            community: false,
            price: { secure: 0.2, community: 0 },
            maxCount: { secure: 1, community: 0 },
            availability: "LOW",
            dataCenters: [{ id: "EU-RO-1", name: "EU Romania 1", availability: "LOW" }],
          },
          {
            id: "AMD Instinct MI300X OAM",
            name: "MI300X",
            manufacturer: "AMD",
            memory: 192,
            secure: true,
            community: true,
            price: { secure: 2, community: 2 },
            maxCount: { secure: 8, community: 8 },
            availability: "HIGH",
            dataCenters: [{ id: "EU-RO-1", name: "EU Romania 1", availability: "HIGH" }],
          },
        ],
      });
    }) as FetchTransport;
    const source = new RunPodV2InventorySource({
      apiKeyProvider: () => "test-api-key",
      fetchTransport,
      clock: { now: () => Date.parse("2026-08-01T00:00:00.000Z") },
    });

    const offers = await source.listGpuInventory({
      gpuIds: ["NVIDIA GeForce RTX 4090"],
      includeEmergencyTier: false,
      cloudLanes: ["secure"],
      gpuCount: 1,
      dataCenterId: "EU-RO-1",
    });

    assert.deepEqual(
      offers.map((offer) => offer.gpuId),
      ["NVIDIA GeForce RTX 4090", "catalog-exact-pro4500-v1"],
    );
    assert.equal(offers[1]?.policyKey, "rtx_pro_4500_blackwell");
    assert.equal(offers[1]?.availability, "high");
    assert.ok(seen.every((request) => request.authorization === "Bearer test-api-key"));
    assert.ok(seen.every((request) => !request.url.includes("test-api-key")));
    assert.equal(seen.length, 2);
    assert.ok(seen.some((request) => request.url === "https://api.runpod.io/v2/catalog/datacenters"));
  });

  it("uses only each GPU's EU-RO-1 availability and uses the data-center endpoint only for volume support", async () => {
    const fetchTransport: FetchTransport = (async (input) => {
      if (String(input).endsWith("/catalog/datacenters")) {
        return jsonResponse({
          dataCenters: [
            { id: "US-TX-1", networkVolumeTypes: null },
            { id: "EU-RO-1", networkVolumeTypes: ["STANDARD"] },
          ],
        });
      }
      return jsonResponse({
        gpus: [
          {
            id: "NVIDIA GeForce RTX 4090",
            name: "RTX 4090",
            manufacturer: "NVIDIA",
            memory: 24,
            secure: true,
            price: { secure: 0.44 },
            maxCount: { secure: 1 },
            availability: "HIGH",
            dataCenters: [
              { id: "US-TX-1", availability: "NOT_RELEVANT" },
              { id: "EU-RO-1", name: "EU Romania 1", availability: "NONE" },
            ],
          },
          {
            id: "NVIDIA GeForce RTX 5090",
            name: "RTX 5090",
            manufacturer: "NVIDIA",
            memory: 32,
            secure: true,
            price: { secure: 0.7 },
            maxCount: { secure: 1 },
            availability: "NONE",
            dataCenters: [{ id: "EU-RO-1", name: "EU Romania 1", availability: "HIGH" }],
          },
        ],
      });
    }) as FetchTransport;
    const source = new RunPodV2InventorySource({
      apiKeyProvider: () => "test-key",
      fetchTransport,
    });

    const offers = await source.listGpuInventory({
      gpuIds: ["NVIDIA GeForce RTX 4090", "NVIDIA GeForce RTX 5090"],
      includeEmergencyTier: false,
      cloudLanes: ["secure"],
      gpuCount: 1,
      dataCenterId: "EU-RO-1",
    });

    assert.deepEqual(
      offers.map((offer) => [offer.gpuId, offer.availability]),
      [
        ["NVIDIA GeForce RTX 4090", "none"],
        ["NVIDIA GeForce RTX 5090", "high"],
      ],
    );
  });
});

describe("RunPodRestProvider", () => {
  const unusedInventory: GpuInventorySource = {
    async listGpuInventory() {
      return [];
    },
  };

  function createRequest(): CreatePodFromTemplateRequest {
    return {
      name: "imageforge-request1",
      startRequestId: "request1",
      templateId: "template1",
      networkVolumeId: "volume1",
      networkVolumeDataCenterId: "EU-RO-1",
      networkVolumeMountPath: "/workspace",
      workerPort: 8000,
      cloud: "secure",
      gpuTypeIds: ["NVIDIA GeForce RTX 4090", "NVIDIA GeForce RTX 5090"],
      gpuCount: 1,
      gpuTypePriority: "custom",
      interruptible: false,
      allowEmergencyGpuTier: false,
      constraints: { allowedCudaVersions: ["13.0"], minRamPerGpuGb: 16 },
    };
  }

  it("sends an ordered one-GPU v1 template/volume request and maps the actual GPU", async () => {
    const dynamicGpuId = "catalog-exact-pro4500-v1";
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | null = null;
    let capturedAuthorization: string | null = null;
    let capturedRedirect = "";
    const fetchTransport: FetchTransport = (async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      capturedAuthorization = new Headers(init?.headers).get("authorization");
      capturedRedirect = String(init?.redirect);
      return jsonResponse(
        {
          id: "newpod1",
          name: "imageforge-request1",
          desiredStatus: "RUNNING",
          gpu: { id: dynamicGpuId, displayName: "RTX PRO 4500 Blackwell", count: 1 },
          templateId: "template1",
          interruptible: false,
          networkVolume: { id: "volume1", dataCenterId: "EU-RO-1" },
          volumeMountPath: "/workspace",
          machine: { secureCloud: true, dataCenterId: "EU-RO-1" },
          ports: ["8000/http"],
          adjustedCostPerHr: 0.5,
          costPerHr: "0.55",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        201,
      );
    }) as FetchTransport;
    const inventorySource: GpuInventorySource = {
      async listGpuInventory() {
        return [
          makeOffer(),
          makeOffer({
            gpuId: "AMD Instinct MI300X OAM",
            displayName: "RTX PRO 4500 Blackwell",
            manufacturer: "AMD",
            memoryGb: 32,
            policyKey: "spoofed_dynamic_gpu",
          }),
          makeOffer({
            gpuId: dynamicGpuId,
            displayName: "RTX PRO 4500 Blackwell",
            policyKey: "rtx_pro_4500_blackwell",
            coldPriority: 1,
          }),
        ];
      },
    };
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => "secure-test-key",
      fetchTransport,
      inventorySource,
    });

    const inventory = await provider.listGpuInventory({
      gpuIds: ["NVIDIA GeForce RTX 4090"],
      includeEmergencyTier: false,
      cloudLanes: ["secure"],
      gpuCount: 1,
      dataCenterId: "EU-RO-1",
    });
    assert.deepEqual(
      inventory.map((offer) => offer.gpuId),
      ["NVIDIA GeForce RTX 4090", dynamicGpuId],
    );
    const request = {
      ...createRequest(),
      gpuTypeIds: ["NVIDIA GeForce RTX 4090", dynamicGpuId],
    } satisfies CreatePodFromTemplateRequest;
    const pod = await provider.createPodFromTemplate(request);
    const body = capturedBody as Record<string, unknown> | null;

    assert.equal(capturedUrl, "https://rest.runpod.io/v1/pods");
    assert.equal(capturedAuthorization, "Bearer secure-test-key");
    assert.equal(capturedRedirect, "error");
    assert.equal(body?.templateId, "template1");
    assert.equal(body?.networkVolumeId, "volume1");
    assert.equal(body?.gpuCount, 1);
    assert.equal(body?.gpuTypePriority, "custom");
    assert.deepEqual(body?.gpuTypeIds, [
      "NVIDIA GeForce RTX 4090",
      dynamicGpuId,
    ]);
    assert.equal(body?.cloudType, "SECURE");
    assert.equal(body?.env, undefined);
    assert.equal(JSON.stringify(body).includes("secure-test-key"), false);
    assert.equal(pod.gpuId, dynamicGpuId);
    assert.equal(pod.status, "provisioning");
    assert.equal(pod.proxyUrl, "https://newpod1-8000.proxy.runpod.net");
  });

  it("discovers only Pods with the exact managed template, volume, placement, lane, GPU, and port", async () => {
    let capturedUrl = "";
    const valid = validPodResponse();
    const fetchTransport: FetchTransport = (async (input) => {
      capturedUrl = String(input);
      return jsonResponse([
        valid,
        validPodResponse({ id: "template2", templateId: "other-template" }),
        validPodResponse({
          id: "volume2",
          networkVolume: { id: "other-volume", dataCenterId: "EU-RO-1" },
        }),
        validPodResponse({
          id: "wrongdc2",
          networkVolume: { id: "volume1", dataCenterId: "US-TX-1" },
          machine: { secureCloud: true, dataCenterId: "US-TX-1" },
        }),
        validPodResponse({
          id: "community2",
          machine: { secureCloud: false, dataCenterId: "EU-RO-1" },
        }),
        validPodResponse({
          id: "twogpu2",
          gpu: { id: "NVIDIA GeForce RTX 5090", displayName: "RTX 5090", count: 2 },
        }),
        validPodResponse({
          id: "b200pod2",
          gpu: { id: "NVIDIA B200", displayName: "B200", count: 1 },
        }),
        validPodResponse({
          id: "emergencypod2",
          gpu: {
            id: "NVIDIA RTX 2000 Ada Generation",
            displayName: "RTX 2000 Ada",
            count: 1,
          },
        }),
        validPodResponse({ id: "wrongport2", ports: ["9000/http"] }),
        validPodResponse({ id: "spotpod2", interruptible: true }),
      ]);
    }) as FetchTransport;
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => "test-key",
      fetchTransport,
      inventorySource: unusedInventory,
    });

    const pods = await provider.listImageForgePods(discoveryCriteria);
    const url = new URL(capturedUrl);

    assert.deepEqual(pods.map((pod) => pod.id), ["newpod1", "emergencypod2"]);
    assert.equal(url.origin + url.pathname, "https://rest.runpod.io/v1/pods");
    assert.equal(url.searchParams.get("computeType"), "GPU");
    assert.equal(url.searchParams.get("includeMachine"), "true");
    assert.equal(url.searchParams.get("includeNetworkVolume"), "true");
    assert.equal(url.searchParams.get("templateId"), "template1");
    assert.equal(url.searchParams.get("networkVolumeId"), "volume1");
    assert.equal(url.searchParams.get("dataCenterId"), "EU-RO-1");
  });

  it("fails closed when a matching dynamic Pod cannot be correlated to live catalog identity", async () => {
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => "test-key",
      fetchTransport: (async () =>
        jsonResponse([
          validPodResponse({
            id: "unverifiedpod2",
            gpu: {
              id: "AMD Instinct MI300X OAM",
              displayName: "RTX PRO 4500 Blackwell",
              count: 1,
            },
          }),
        ])) as FetchTransport,
      inventorySource: unusedInventory,
    });

    await assert.rejects(
      () => provider.listImageForgePods(discoveryCriteria),
      (error: unknown) =>
        error instanceof RunPodClientError &&
        error.code === "api_response_invalid" &&
        error.retryable,
    );
  });

  it("binds each dynamic catalog ID to its exact approved Blackwell policy", async () => {
    const dynamicGpuId = "catalog-pro-policy-bound-v1";
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => "test-key",
      fetchTransport: (async () =>
        jsonResponse([
          validPodResponse({
            id: "crosspolicy2",
            gpu: {
              id: dynamicGpuId,
              displayName: "RTX PRO 4000 Blackwell",
              count: 1,
            },
          }),
        ])) as FetchTransport,
      inventorySource: {
        async listGpuInventory() {
          return [
            makeOffer({
              gpuId: dynamicGpuId,
              displayName: "RTX PRO 4500 Blackwell",
              memoryGb: 32,
              policyKey: "rtx_pro_4500_blackwell",
              coldPriority: 1,
            }),
          ];
        },
      },
    });
    await provider.listGpuInventory({
      gpuIds: [],
      includeEmergencyTier: false,
      cloudLanes: ["secure"],
      gpuCount: 1,
      dataCenterId: "EU-RO-1",
    });

    await assert.rejects(
      () => provider.listImageForgePods(discoveryCriteria),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "api_response_invalid",
    );
  });

  it("requires explicit emergency authorization on the create primitive", async () => {
    let fetchCalls = 0;
    const emergencyGpuId = "NVIDIA RTX 2000 Ada Generation";
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => "test-key",
      fetchTransport: (async () => {
        fetchCalls += 1;
        return jsonResponse(
          validPodResponse({
            gpu: { id: emergencyGpuId, displayName: "RTX 2000 Ada", count: 1 },
          }),
          201,
        );
      }) as FetchTransport,
      inventorySource: unusedInventory,
    });
    const disabled = {
      ...createRequest(),
      gpuTypeIds: [emergencyGpuId],
      allowEmergencyGpuTier: false,
    } satisfies CreatePodFromTemplateRequest;

    await assert.rejects(
      () => provider.createPodFromTemplate(disabled),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "configuration_invalid",
    );
    assert.equal(fetchCalls, 0);

    const pod = await provider.createPodFromTemplate({
      ...disabled,
      allowEmergencyGpuTier: true,
    });
    assert.equal(fetchCalls, 1);
    assert.equal(pod.gpuId, emergencyGpuId);
  });

  it("marks every accepted-POST JSON or identity validation failure as ambiguous", async (test) => {
    const variants: ReadonlyArray<readonly [string, Response]> = [
      ["malformed JSON", new Response("{", { status: 201 })],
      ["unexpected GPU", jsonResponse(validPodResponse({
        gpu: { id: "NVIDIA L4", displayName: "L4", count: 1 },
      }), 201)],
      ["unexpected count", jsonResponse(validPodResponse({
        gpu: { id: "NVIDIA GeForce RTX 5090", displayName: "RTX 5090", count: 2 },
      }), 201)],
      ["unexpected cloud", jsonResponse(validPodResponse({
        machine: { secureCloud: false, dataCenterId: "EU-RO-1" },
      }), 201)],
      ["unexpected data center", jsonResponse(validPodResponse({
        networkVolume: { id: "volume1", dataCenterId: "US-TX-1" },
        machine: { secureCloud: true, dataCenterId: "US-TX-1" },
      }), 201)],
      ["unexpected template", jsonResponse(validPodResponse({ templateId: "other-template" }), 201)],
      ["unexpected volume", jsonResponse(validPodResponse({
        networkVolume: { id: "other-volume", dataCenterId: "EU-RO-1" },
      }), 201)],
      ["unexpected request marker", jsonResponse(validPodResponse({
        name: "imageforge-other-request",
      }), 201)],
      ["unexpected successful status", jsonResponse(validPodResponse(), 200)],
    ];

    for (const [name, response] of variants) {
      await test.test(name, async () => {
        const provider = new RunPodRestProvider({
          apiKeyProvider: () => "test-key",
          fetchTransport: (async () => response.clone()) as FetchTransport,
          inventorySource: unusedInventory,
        });
        await assert.rejects(
          () => provider.createPodFromTemplate(createRequest()),
          (error: unknown) =>
            error instanceof RunPodClientError &&
            error.mayHaveSucceeded &&
            error.operation === "create_pod",
        );
      });
    }
  });

  it("reconciles a malformed 201 create response through the unique request marker", async () => {
    let createdName = "";
    let createdVisible = false;
    const fetchTransport: FetchTransport = (async (_input, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdName = String(body.name);
        createdVisible = true;
        return new Response("{", { status: 201 });
      }
      return jsonResponse(
        createdVisible
          ? [validPodResponse({
              id: "reconciledpod1",
              name: createdName,
              desiredStatus: "PROVISIONING",
              gpu: {
                id: "NVIDIA GeForce RTX 4090",
                displayName: "RTX 4090",
                count: 1,
              },
            })]
          : [],
      );
    }) as FetchTransport;
    const inventorySource: GpuInventorySource = {
      async listGpuInventory() {
        return [makeOffer()];
      },
    };
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => "test-key",
      fetchTransport,
      inventorySource,
    });
    const controller = new RunPodLifecycleController({
      provider,
      config: makeConfig(),
      workerHealthProbe: new FakeWorkerHealthProbe(),
    });

    const result = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "malformed201",
    });

    assert.equal(result.outcome, "reconciled_ambiguous_create");
    assert.equal(result.pod.id, "reconciledpod1");
  });

  it("requires a worker health probe whenever the real provider is used", () => {
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => "test-key",
      fetchTransport: (async () => jsonResponse([])) as FetchTransport,
      inventorySource: unusedInventory,
    });

    assert.throws(
      () => new RunPodLifecycleController({ provider, config: makeConfig() }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "configuration_invalid",
    );
  });

  it("pins credentials to the official RunPod API hosts and version paths", () => {
    assert.throws(
      () =>
        new RunPodRestProvider({
          apiKeyProvider: () => "test-key",
          lifecycleBaseUrl: "https://example.com/v1",
          inventorySource: unusedInventory,
        }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "configuration_invalid",
    );
    assert.throws(
      () =>
        new RunPodV2InventorySource({
          apiKeyProvider: () => "test-key",
          baseUrl: "https://api.runpod.io/v1",
        }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "configuration_invalid",
    );
  });

  it("uses DELETE for confirmed controller termination primitives", async () => {
    let capturedMethod = "";
    let capturedUrl = "";
    const fetchTransport: FetchTransport = (async (input, init) => {
      capturedMethod = String(init?.method);
      capturedUrl = String(input);
      return new Response(null, { status: 204 });
    }) as FetchTransport;
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => "test-key",
      fetchTransport,
      inventorySource: unusedInventory,
    });

    await provider.terminatePod("podtodelete1");

    assert.equal(capturedMethod, "DELETE");
    assert.equal(capturedUrl, "https://rest.runpod.io/v1/pods/podtodelete1");
  });

  it("rejects every unsafe Pod ID before GET or DELETE URL construction", async () => {
    let fetchCalls = 0;
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => "test-key",
      fetchTransport: (async () => {
        fetchCalls += 1;
        return new Response(null, { status: 204 });
      }) as FetchTransport,
      inventorySource: unusedInventory,
    });

    for (const podId of ["", ".", "..", "/", "%2e", "%2e%2e", "pod/child", "pod%2fchild"]) {
      await assert.rejects(
        () => provider.getPod(podId, discoveryCriteria),
        (error: unknown) => error instanceof RunPodClientError && error.code === "api_response_invalid",
      );
      await assert.rejects(
        () => provider.terminatePod(podId),
        (error: unknown) => error instanceof RunPodClientError && error.code === "api_response_invalid",
      );
    }
    assert.equal(fetchCalls, 0);
  });

  it("revalidates and deletes only a previously bound dynamic-GPU Pod after catalog omission", async () => {
    const dynamicGpuId = "catalog-pro-stop-bound-v1";
    let catalogOffers = [makeOffer({
      gpuId: dynamicGpuId,
      displayName: "RTX PRO 4500 Blackwell",
      memoryGb: 32,
      policyKey: "rtx_pro_4500_blackwell",
      coldPriority: 1,
    })];
    const deleted: string[] = [];
    const dynamicPod = validPodResponse({
      id: "dynamicstop1",
      gpu: { id: dynamicGpuId, displayName: "RTX PRO 4500 Blackwell", count: 1 },
    });
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => "test-key",
      inventorySource: { async listGpuInventory() { return catalogOffers; } },
      fetchTransport: (async (input, init) => {
        const url = String(input);
        if (init?.method === "DELETE") {
          deleted.push(url);
          return new Response(null, { status: 204 });
        }
        if (url.includes("/pods/dynamicstop1?")) return jsonResponse(dynamicPod);
        if (url.includes("/pods/unbounddynamic1?")) {
          return jsonResponse({ ...dynamicPod, id: "unbounddynamic1" });
        }
        return jsonResponse([dynamicPod]);
      }) as FetchTransport,
    });
    const controller = new RunPodLifecycleController({
      provider,
      config: makeConfig(),
      workerHealthProbe: new FakeWorkerHealthProbe(),
      tokenFactory: () => "dynamic-stop-token",
    });
    assert.deepEqual((await controller.refresh()).pods.map((pod) => pod.id), ["dynamicstop1"]);
    catalogOffers = [];
    assert.deepEqual((await controller.refresh()).pods.map((pod) => pod.id), ["dynamicstop1"]);

    assert.equal((await provider.getPod("dynamicstop1", discoveryCriteria))?.id, "dynamicstop1");
    await assert.rejects(
      () => provider.getPod("unbounddynamic1", discoveryCriteria),
      (error: unknown) => error instanceof RunPodClientError && error.code === "api_response_invalid",
    );
    const confirmation = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: "dynamicstop1",
    });
    await controller.stopGpu({
      intent: "confirm_stop_gpu",
      source: "foreground_user",
      podId: "dynamicstop1",
      confirmationToken: confirmation.token,
    });
    assert.deepEqual(deleted, ["https://rest.runpod.io/v1/pods/dynamicstop1"]);
  });

  it("never includes the API key or upstream response body in errors", async () => {
    const apiKey = "super-secret-key-value";
    let capturedUrl = "";
    const fetchTransport: FetchTransport = (async (input) => {
      capturedUrl = String(input);
      return jsonResponse(
        { detail: `internal echo ${apiKey}`, env: { WORKER_SECRET: "also-secret" } },
        500,
      );
    }) as FetchTransport;
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => apiKey,
      fetchTransport,
      inventorySource: unusedInventory,
    });

    let caught: unknown;
    try {
      await provider.createPodFromTemplate(createRequest());
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof RunPodClientError);
    const serialized = JSON.stringify(caught);
    assert.equal(capturedUrl.includes(apiKey), false);
    assert.equal(serialized.includes(apiKey), false);
    assert.equal(serialized.includes("also-secret"), false);
    assert.equal(String(caught).includes(apiKey), false);
    assert.equal(inspect(caught, { depth: null, showHidden: true }).includes(apiKey), false);
    assert.equal(inspect(caught, { depth: null, showHidden: true }).includes("also-secret"), false);
    assert.equal(Object.hasOwn(caught, "cause"), false);

    const causeProvider = new RunPodRestProvider({
      apiKeyProvider: () => apiKey,
      fetchTransport: (async () => {
        throw new Error(`transport cause leaked ${apiKey} and also-secret`);
      }) as FetchTransport,
      inventorySource: unusedInventory,
    });
    let causeError: unknown;
    try {
      await causeProvider.createPodFromTemplate(createRequest());
    } catch (error) {
      causeError = error;
    }
    const inspectedCause = inspect(causeError, { depth: null, showHidden: true });
    assert.equal(inspectedCause.includes(apiKey), false);
    assert.equal(inspectedCause.includes("also-secret"), false);
    assert.equal(causeError instanceof RunPodClientError, true);
    assert.equal(Object.hasOwn(causeError as object, "cause"), false);
  });
});
