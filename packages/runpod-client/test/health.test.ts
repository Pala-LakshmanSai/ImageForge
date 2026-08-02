import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HttpWorkerHealthProbe,
  RunPodClientError,
  deriveRunPodProxyUrl,
  type FetchTransport,
} from "../src/index.js";

describe("HttpWorkerHealthProbe", () => {
  it("probes the derived Pod proxy /v1/health endpoint and validates its phase", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedRedirect = "";
    const probe = new HttpWorkerHealthProbe({
      fetchTransport: (async (input, init) => {
        capturedUrl = String(input);
        capturedMethod = String(init?.method);
        capturedRedirect = String(init?.redirect);
        return new Response(
          JSON.stringify(healthPayload("gpu_load", 0.75)),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as FetchTransport,
    });

    const health = await probe.getHealth(deriveRunPodProxyUrl("healthpod1", 8000));

    assert.equal(capturedUrl, "https://healthpod1-8000.proxy.runpod.net/v1/health");
    assert.equal(capturedMethod, "GET");
    assert.equal(capturedRedirect, "error");
    assert.deepEqual(health, {
      schemaVersion: 1,
      phase: "gpu_load",
      phaseProgress: 0.75,
    });
  });

  it("accepts the worker's exact warmup and error phase spellings", async () => {
    const phases = ["warmup", "error"] as const;
    let nextPhase = 0;
    const probe = new HttpWorkerHealthProbe({
      fetchTransport: (async () =>
        jsonHealthResponse(phases[nextPhase++] ?? "error")) as FetchTransport,
    });

    assert.equal(
      (await probe.getHealth(deriveRunPodProxyUrl("warmuppod1", 8000))).phase,
      "warmup",
    );
    assert.equal(
      (await probe.getHealth(deriveRunPodProxyUrl("errorpod1", 8000))).phase,
      "error",
    );

    const legacySpellingProbe = new HttpWorkerHealthProbe({
      fetchTransport: (async () => jsonHealthResponse("warm_up")) as FetchTransport,
    });
    await assert.rejects(
      () => legacySpellingProbe.getHealth(deriveRunPodProxyUrl("legacyphase1", 8000)),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "api_response_invalid",
    );
  });

  it("accepts an attached approved GPU while CUDA is still loading", async () => {
    const probe = new HttpWorkerHealthProbe({
      fetchTransport: (async () => jsonResponse({
        ...healthPayload("gpu_load", 0.05),
        gpu: {
          state: "loading",
          available: true,
          approved: true,
          name: "NVIDIA GeForce RTX 4090",
          device_count: 1,
        },
      })) as FetchTransport,
    });
    assert.equal(
      (await probe.getHealth(deriveRunPodProxyUrl("attachedgpu1", 8000))).phase,
      "gpu_load",
    );
  });

  it("rejects non-RunPod proxy origins before making a request", async () => {
    let fetchCalls = 0;
    const probe = new HttpWorkerHealthProbe({
      fetchTransport: (async () => {
        fetchCalls += 1;
        return new Response(null, { status: 200 });
      }) as FetchTransport,
    });

    for (const invalidUrl of [
      "https://example.com",
      "https://healthpod1-9000.proxy.runpod.net",
      "https://healthpod1-8000.proxy.runpod.net:444",
      "https://healthpod1-8000.proxy.runpod.net/unreviewed-path",
    ]) {
      await assert.rejects(
        () => probe.getHealth(invalidUrl),
        (error: unknown) =>
          error instanceof RunPodClientError && error.code === "api_response_invalid",
      );
    }
    assert.equal(fetchCalls, 0);
  });

  it("rejects lookalike services, wrong model contracts, multi-GPU readiness, and inconsistent status", async () => {
    const ready = healthPayload("ready", 1);
    const variants = [
      { ...ready, service: "not-imageforge" },
      { ...ready, model: { ...(ready.model as Record<string, unknown>), revision: "latest" } },
      { ...ready, gpu: { ...(ready.gpu as Record<string, unknown>), device_count: 2 } },
      { ...ready, model: { ...(ready.model as Record<string, unknown>), status: "loading" } },
    ];
    for (const payload of variants) {
      const probe = new HttpWorkerHealthProbe({
        fetchTransport: (async () => jsonResponse(payload)) as FetchTransport,
      });
      await assert.rejects(
        () => probe.getHealth(deriveRunPodProxyUrl("stricthealth1", 8000)),
        (error: unknown) => error instanceof RunPodClientError && error.code === "api_response_invalid",
      );
    }
  });

  it("settles an abort even when the fetch transport never resolves", async () => {
    const probe = new HttpWorkerHealthProbe({
      fetchTransport: (() => new Promise<Response>(() => undefined)) as FetchTransport,
    });
    const controller = new AbortController();
    const pending = probe.getHealth(deriveRunPodProxyUrl("aborthealth1", 8000), controller.signal);
    controller.abort();
    await assert.rejects(
      () => pending,
      (error: unknown) => error instanceof RunPodClientError && error.code === "operation_aborted",
    );
  });

  it("settles an abort when health response body parsing never resolves", async () => {
    const response = {
      ok: true,
      status: 200,
      json: () => new Promise<unknown>(() => undefined),
    } as Response;
    const probe = new HttpWorkerHealthProbe({
      fetchTransport: (async () => response) as FetchTransport,
    });
    const controller = new AbortController();
    const pending = probe.getHealth(deriveRunPodProxyUrl("abortbody1", 8000), controller.signal);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(
      () => pending,
      (error: unknown) => error instanceof RunPodClientError && error.code === "operation_aborted",
    );
  });
});

function jsonHealthResponse(phase: string): Response {
  return jsonResponse(healthPayload(phase, phase === "ready" ? 1 : 0.5));
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function healthPayload(phase: string, progress: number): Record<string, unknown> {
  const ready = phase === "warmup" || phase === "ready";
  return {
    schema_version: 1,
    service: "imageforge-worker",
    version: "0.1.2",
    process: { status: "ok", uptime_ms: 100 },
    model: {
      id: "black-forest-labs/FLUX.2-klein-4B",
      revision: "e7b7dc27f91deacad38e78976d1f2b499d76a294",
      precision: "bfloat16",
      status: phase === "ready" ? "ready" : phase === "error" ? "error" : "loading",
    },
    gpu: {
      state: ready ? "ready" : "loading",
      available: ready,
      approved: ready,
      name: ready ? "NVIDIA GeForce RTX 4090" : null,
      device_count: ready ? 1 : 0,
    },
    phase,
    phase_progress: progress,
  };
}
