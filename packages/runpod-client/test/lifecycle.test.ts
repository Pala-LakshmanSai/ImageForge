import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FakeRunPodProvider,
  FakeWorkerHealthProbe,
  RunPodClientError,
  RunPodLifecycleController,
  deriveRunPodProxyUrl,
} from "../src/index.js";
import { makeConfig, makeOffer, makePod } from "./helpers.js";

function makeController(
  provider: FakeRunPodProvider,
  options: {
    readonly health?: FakeWorkerHealthProbe;
    readonly now?: () => number;
    readonly token?: () => string;
  } = {},
): RunPodLifecycleController {
  return new RunPodLifecycleController({
    provider,
    config: makeConfig(),
    ...(options.health === undefined ? {} : { workerHealthProbe: options.health }),
    ...(options.now === undefined ? {} : { clock: { now: options.now } }),
    ...(options.token === undefined ? {} : { tokenFactory: options.token }),
  });
}

describe("RunPodLifecycleController refresh and start", () => {
  it("calls live inventory and existing-Pod discovery on every refresh", async () => {
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
    const controller = makeController(provider);

    await controller.refresh();
    await controller.refresh();

    assert.equal(provider.calls.inventory.length, 2);
    assert.equal(provider.calls.list.length, 2);
    assert.equal(provider.calls.inventory[0]?.gpuCount, 1);
    assert.equal(provider.calls.inventory[0]?.dataCenterId, "EU-RO-1");
    assert.equal(provider.calls.inventory[0]?.includeEmergencyTier, false);
  });

  it("does not create when all live approved inventory is unavailable", async () => {
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer({ availability: "none" })],
    });
    const controller = makeController(provider);

    await assert.rejects(
      () =>
        controller.startGpu({
          intent: "start_gpu",
          source: "foreground_user",
          requestId: "unavailable1",
        }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "no_gpu_available",
    );
    assert.equal(provider.calls.create.length, 0);
  });

  it("soft-falls back from catalog failure to one authoritative ordered create", async () => {
    const provider = new FakeRunPodProvider();
    provider.failNext(
      "inventory",
      new RunPodClientError({
        code: "api_network_error",
        message: "catalog offline",
        operation: "inventory",
        retryable: true,
      }),
    );
    const controller = makeController(provider);

    const result = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "fallback1",
      expectedImageCount: 450,
    });

    assert.equal(result.outcome, "created");
    assert.equal(provider.calls.create.length, 1);
    assert.equal(provider.calls.create[0]?.gpuCount, 1);
    assert.equal(provider.calls.create[0]?.gpuTypePriority, "custom");
    assert.equal(provider.calls.create[0]?.cloud, "secure");
    assert.deepEqual(provider.calls.create[0]?.gpuTypeIds, [
      "NVIDIA GeForce RTX 4090",
      "NVIDIA GeForce RTX 5090",
      "NVIDIA L4",
      "NVIDIA RTX A4500",
      "NVIDIA RTX 4000 Ada Generation",
    ]);
    assert.equal(provider.calls.terminate.length, 0);
    assert.ok(result.snapshot.warnings.some((warning) => warning.code === "inventory_fallback"));
  });

  it("connects to an existing ImageForge Pod instead of creating another", async () => {
    const existing = makePod();
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()], pods: [existing] });
    const controller = makeController(provider);

    const result = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "ignored1",
    });

    assert.equal(result.outcome, "connected_existing");
    assert.equal(result.pod.id, existing.id);
    assert.equal(provider.calls.create.length, 0);
  });

  it("coalesces concurrent local Start clicks into exactly one create", async () => {
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
    const controller = makeController(provider);
    const intent = {
      intent: "start_gpu" as const,
      source: "foreground_user" as const,
      requestId: "doubleclick1",
    };

    const first = controller.startGpu(intent);
    const second = controller.startGpu(intent);
    assert.equal(first, second);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(provider.calls.create.length, 1);
    assert.equal(firstResult.pod.id, secondResult.pod.id);
  });

  it("surfaces external create-race duplicates without terminating either Pod", async () => {
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
    provider.onCreate((request, fake) => {
      fake.addPod(
        makePod({
          id: "rivalpod1",
          name: "imageforge-rivalrequest",
          startRequestId: "rivalrequest",
          status: "provisioning",
        }),
      );
      assert.equal(request.gpuCount, 1);
      return undefined;
    });
    const controller = makeController(provider);

    const result = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "ourrequest1",
    });

    assert.equal(result.snapshot.pods.length, 2);
    const duplicateWarning = result.snapshot.warnings.find(
      (warning) => warning.code === "duplicate_pods",
    );
    assert.equal(duplicateWarning?.podIds.length, 2);
    assert.equal(provider.calls.terminate.length, 0);
  });

  it("reconciles an ambiguous create by its unique request marker", async () => {
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
    provider.onCreate((request, fake) => {
      fake.addPod(
        makePod({
          id: "ambiguouspod1",
          name: request.name,
          startRequestId: request.startRequestId,
          status: "provisioning",
        }),
      );
      throw new RunPodClientError({
        code: "api_network_error",
        message: "connection closed",
        operation: "create_pod",
        retryable: true,
        mayHaveSucceeded: true,
      });
    });
    const controller = makeController(provider);

    const result = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "ambiguous1",
    });

    assert.equal(result.outcome, "reconciled_ambiguous_create");
    assert.equal(result.pod.id, "ambiguouspod1");
    assert.equal(provider.calls.create.length, 1);
  });

  it("refreshes a replacement Pod ID and derives its new proxy automatically", async () => {
    const oldProxy = deriveRunPodProxyUrl("oldpod1", 8000);
    const newProxy = deriveRunPodProxyUrl("newpod2", 8000);
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [makePod({ id: "oldpod1", proxyUrl: oldProxy })],
    });
    const health = new FakeWorkerHealthProbe();
    health.setHealth(oldProxy, { schemaVersion: 1, phase: "ready", phaseProgress: 1 });
    health.setHealth(newProxy, { schemaVersion: 1, phase: "weights", phaseProgress: 0.4 });
    const controller = makeController(provider, { health });

    const oldSnapshot = await controller.refresh();
    provider.replacePodId("oldpod1", "newpod2");
    const newSnapshot = await controller.refresh();

    assert.equal(oldSnapshot.proxyUrl, oldProxy);
    assert.equal(oldSnapshot.phase, "ready");
    assert.equal(newSnapshot.selectedPodId, "newpod2");
    assert.equal(newSnapshot.proxyUrl, newProxy);
    assert.equal(newSnapshot.phase, "loading");
  });

  it("returns a typed error when Pod discovery fails while still attempting both refresh calls", async () => {
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
    provider.failNext(
      "list",
      new RunPodClientError({
        code: "api_network_error",
        message: "pods offline",
        operation: "list_pods",
        retryable: true,
      }),
    );
    const controller = makeController(provider);

    await assert.rejects(
      () => controller.refresh(),
      (error: unknown) =>
        error instanceof RunPodClientError && error.operation === "list_pods",
    );
    assert.equal(provider.calls.inventory.length, 1);
    assert.equal(provider.calls.list.length, 1);
    assert.equal(controller.getSnapshot().phase, "error");
  });
});

describe("RunPodLifecycleController explicit Stop GPU", () => {
  it("requires a Pod-bound confirmation before termination", async () => {
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [makePod({ id: "stoppod1" })],
    });
    let tokenNumber = 0;
    const controller = makeController(provider, {
      token: () => `confirm-token-${++tokenNumber}`,
    });
    await controller.refresh();

    await assert.rejects(
      () =>
        controller.stopGpu({
          intent: "confirm_stop_gpu",
          source: "foreground_user",
          podId: "stoppod1",
          confirmationToken: "not-issued",
        }),
      (error: unknown) =>
        error instanceof RunPodClientError &&
        error.code === "termination_confirmation_required",
    );
    assert.equal(provider.calls.terminate.length, 0);

    const confirmation = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: "stoppod1",
    });
    assert.match(confirmation.message, /network volume will remain/i);
    const stopped = await controller.stopGpu({
      intent: "confirm_stop_gpu",
      source: "foreground_user",
      podId: confirmation.podId,
      confirmationToken: confirmation.token,
    });

    assert.deepEqual(provider.calls.terminate, ["stoppod1"]);
    assert.equal(stopped.snapshot.phase, "offline");
  });

  it("surfaces termination failure, keeps the Pod, and consumes the confirmation", async () => {
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [makePod({ id: "failstop1" })],
    });
    provider.failNext(
      "terminate",
      new RunPodClientError({
        code: "api_network_error",
        message: "delete failed",
        operation: "terminate_pod",
        retryable: true,
        mayHaveSucceeded: false,
      }),
    );
    const controller = makeController(provider, { token: () => "confirmation-token" });
    await controller.refresh();
    const confirmation = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: "failstop1",
    });
    const confirmedIntent = {
      intent: "confirm_stop_gpu" as const,
      source: "foreground_user" as const,
      podId: "failstop1",
      confirmationToken: confirmation.token,
    };

    await assert.rejects(
      () => controller.stopGpu(confirmedIntent),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "pod_termination_failed",
    );
    assert.equal(controller.getSnapshot().pods[0]?.id, "failstop1");
    assert.equal(controller.getSnapshot().phase, "error");
    await assert.rejects(
      () => controller.stopGpu(confirmedIntent),
      (error: unknown) =>
        error instanceof RunPodClientError &&
        error.code === "termination_confirmation_required",
    );
    assert.equal(provider.calls.terminate.length, 1);
  });
});
