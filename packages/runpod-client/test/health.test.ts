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
          JSON.stringify({ schema_version: 1, phase: "gpu_load", phase_progress: 0.75 }),
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
});

function jsonHealthResponse(phase: string): Response {
  return new Response(
    JSON.stringify({ schema_version: 1, phase, phase_progress: 0.5 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
