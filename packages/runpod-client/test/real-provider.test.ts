import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RunPodClientError,
  RunPodRestProvider,
  RunPodV2InventorySource,
  type CreatePodFromTemplateRequest,
  type FetchTransport,
  type GpuInventorySource,
} from "../src/index.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
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
      assert.match(url, /minCudaVersion=12.8/);
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
      gpuTypeIds: ["NVIDIA GeForce RTX 4090", "catalog-exact-pro4500-v1"],
      gpuCount: 1,
      gpuTypePriority: "custom",
      interruptible: false,
      constraints: { allowedCudaVersions: ["12.8"], minRamPerGpuGb: 16 },
    };
  }

  it("sends an ordered one-GPU v1 template/volume request and maps the actual GPU", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | null = null;
    let capturedAuthorization: string | null = null;
    const fetchTransport: FetchTransport = (async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      capturedAuthorization = new Headers(init?.headers).get("authorization");
      return jsonResponse(
        {
          id: "newpod1",
          name: "imageforge-request1",
          desiredStatus: "RUNNING",
          gpu: { id: "catalog-exact-pro4500-v1" },
          templateId: "template1",
          networkVolume: { id: "volume1" },
          machine: { secureCloud: true },
          adjustedCostPerHr: 0.5,
          costPerHr: "0.55",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        201,
      );
    }) as FetchTransport;
    const provider = new RunPodRestProvider({
      apiKeyProvider: () => "secure-test-key",
      fetchTransport,
      inventorySource: unusedInventory,
    });

    const pod = await provider.createPodFromTemplate(createRequest());
    const body = capturedBody as Record<string, unknown> | null;

    assert.equal(capturedUrl, "https://rest.runpod.io/v1/pods");
    assert.equal(capturedAuthorization, "Bearer secure-test-key");
    assert.equal(body?.templateId, "template1");
    assert.equal(body?.networkVolumeId, "volume1");
    assert.equal(body?.gpuCount, 1);
    assert.equal(body?.gpuTypePriority, "custom");
    assert.deepEqual(body?.gpuTypeIds, [
      "NVIDIA GeForce RTX 4090",
      "catalog-exact-pro4500-v1",
    ]);
    assert.equal(body?.cloudType, "SECURE");
    assert.equal(body?.env, undefined);
    assert.equal(JSON.stringify(body).includes("secure-test-key"), false);
    assert.equal(pod.gpuId, "catalog-exact-pro4500-v1");
    assert.equal(pod.status, "provisioning");
    assert.equal(pod.proxyUrl, "https://newpod1-8000.proxy.runpod.net");
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
  });
});
