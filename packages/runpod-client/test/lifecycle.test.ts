import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FakeRunPodProvider,
  FakeWorkerHealthProbe,
  RunPodClientError,
  RunPodLifecycleController,
  deriveRunPodProxyUrl,
  type RunPodClientConfig,
} from "../src/index.js";
import { makeConfig, makeOffer, makePod } from "./helpers.js";

function makeController(
  provider: FakeRunPodProvider,
  options: {
    readonly health?: FakeWorkerHealthProbe;
    readonly now?: () => number;
    readonly token?: () => string;
    readonly configOverrides?: Partial<RunPodClientConfig>;
  } = {},
): RunPodLifecycleController {
  return new RunPodLifecycleController({
    provider,
    config: makeConfig(options.configOverrides),
    ...(options.health === undefined ? {} : { workerHealthProbe: options.health }),
    ...(options.now === undefined ? {} : { clock: { now: options.now } }),
    ...(options.token === undefined ? {} : { tokenFactory: options.token }),
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { promise, resolve };
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

  it("keeps RTX 2000 Ada unavailable unless the emergency tier is explicitly enabled", async () => {
    const emergencyOffer = makeOffer({
      gpuId: "NVIDIA RTX 2000 Ada Generation",
      displayName: "RTX 2000 Ada",
      policyKey: "rtx_2000_ada",
      coldPriority: 100,
      emergency: true,
    });
    const disabledProvider = new FakeRunPodProvider({ inventory: [emergencyOffer] });

    await assert.rejects(
      () =>
        makeController(disabledProvider).startGpu({
          intent: "start_gpu",
          source: "foreground_user",
          requestId: "emergencyoff1",
        }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "no_gpu_available",
    );
    assert.equal(disabledProvider.calls.create.length, 0);

    const enabledProvider = new FakeRunPodProvider({ inventory: [emergencyOffer] });
    const enabled = makeController(enabledProvider, {
      configOverrides: { allowEmergencyGpuTier: true },
    });
    const result = await enabled.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "emergencyon1",
    });

    assert.equal(result.pod.gpuId, "NVIDIA RTX 2000 Ada Generation");
    assert.deepEqual(enabledProvider.calls.create[0]?.gpuTypeIds, [
      "NVIDIA RTX 2000 Ada Generation",
    ]);
  });

  it("keeps an existing emergency Pod visible and stoppable without reusing it after opt-out", async () => {
    const emergencyPod = makePod({
      id: "existingemergency1",
      gpuId: "NVIDIA RTX 2000 Ada Generation",
      gpuDisplayName: "RTX 2000 Ada",
    });
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [emergencyPod],
    });
    const controller = makeController(provider, { token: () => "emergency-stop-token" });

    await assert.rejects(
      () =>
        controller.startGpu({
          intent: "start_gpu",
          source: "foreground_user",
          requestId: "emergencyexisting1",
        }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "operation_in_progress",
    );
    assert.equal(provider.calls.create.length, 0);
    assert.equal(controller.getSnapshot().pods[0]?.id, emergencyPod.id);

    const confirmation = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: emergencyPod.id,
    });
    await controller.stopGpu({
      intent: "confirm_stop_gpu",
      source: "foreground_user",
      podId: emergencyPod.id,
      confirmationToken: confirmation.token,
    });
    assert.deepEqual(provider.calls.terminate, [emergencyPod.id]);
  });

  it("blocks creation when inventory failure leaves an existing dynamic PRO Pod unverified", async () => {
    const provider = new FakeRunPodProvider({
      inventory: [],
      pods: [
        makePod({
          id: "existingpro1",
          gpuId: "catalog-pro-4500-v1",
          gpuDisplayName: "RTX PRO 4500 Blackwell",
        }),
      ],
    });
    provider.failNext("inventory", new Error("catalog unavailable"));
    const controller = makeController(provider);

    await assert.rejects(
      () =>
        controller.startGpu({
          intent: "start_gpu",
          source: "foreground_user",
          requestId: "dynamicfail1",
        }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "api_response_invalid",
    );
    assert.equal(provider.calls.create.length, 0);
    assert.equal(controller.getSnapshot().phase, "error");
  });

  it("accepts an approved later candidate selected by RunPod from the ordered fallback list", async () => {
    const provider = new FakeRunPodProvider({
      inventory: [
        makeOffer(),
        makeOffer({
          gpuId: "NVIDIA GeForce RTX 5090",
          displayName: "RTX 5090",
          policyKey: "rtx_5090",
          coldPriority: 2,
        }),
      ],
    });
    provider.useActualGpuForNextCreate("NVIDIA GeForce RTX 5090");
    const controller = makeController(provider);

    const result = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "latercandidate1",
    });

    assert.deepEqual(provider.calls.create[0]?.gpuTypeIds, [
      "NVIDIA GeForce RTX 4090",
      "NVIDIA GeForce RTX 5090",
    ]);
    assert.equal(result.pod.gpuId, "NVIDIA GeForce RTX 5090");
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

  it("never reuses error or unknown Pods and creates past an exited Pod", async (test) => {
    for (const status of ["error", "unknown"] as const) {
      await test.test(`blocks creation while an existing Pod is ${status}`, async () => {
        const provider = new FakeRunPodProvider({
          inventory: [makeOffer()],
          pods: [makePod({ status })],
        });
        await assert.rejects(
          () =>
            makeController(provider).startGpu({
              intent: "start_gpu",
              source: "foreground_user",
              requestId: `blocked${status}`,
            }),
          (error: unknown) =>
            error instanceof RunPodClientError && error.code === "operation_in_progress",
        );
        assert.equal(provider.calls.create.length, 0);
      });
    }

    await test.test("does not reuse an exited Pod", async () => {
      const provider = new FakeRunPodProvider({
        inventory: [makeOffer()],
        pods: [makePod({ status: "exited" })],
      });
      const result = await makeController(provider).startGpu({
        intent: "start_gpu",
        source: "foreground_user",
        requestId: "afterexited1",
      });
      assert.equal(result.outcome, "created");
      assert.equal(provider.calls.create.length, 1);
    });
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

  it("selects duplicate Pods deterministically when creation timestamps are invalid", async () => {
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [
        makePod({ id: "zpod1", createdAt: "invalid" }),
        makePod({ id: "apod1", createdAt: "also-invalid" }),
      ],
    });
    const controller = makeController(provider);

    const snapshot = await controller.refresh();

    assert.equal(snapshot.selectedPodId, "apod1");
    assert.equal(snapshot.warnings[0]?.code, "duplicate_pods");
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

  it("ignores an exited Pod with a reused marker when reconciling an ambiguous create", async () => {
    const requestId = "reusedmarker1";
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [
        makePod({
          id: "oldexited1",
          name: `imageforge-${requestId}`,
          startRequestId: requestId,
          status: "exited",
        }),
      ],
    });
    provider.onCreate((request, fake) => {
      fake.addPod(
        makePod({
          id: "newactive1",
          name: request.name,
          startRequestId: request.startRequestId,
          status: "provisioning",
        }),
      );
      throw new RunPodClientError({
        code: "api_network_error",
        message: "create result unknown",
        operation: "create_pod",
        retryable: true,
        mayHaveSucceeded: true,
      });
    });
    const controller = makeController(provider);

    const result = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId,
    });

    assert.equal(result.outcome, "reconciled_ambiguous_create");
    assert.equal(result.pod.id, "newactive1");
  });

  it("retains the exact validated create result when discovery only finds an old reused marker", async () => {
    const requestId = "repeat201";
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [
        makePod({
          id: "oldexited1",
          name: `imageforge-${requestId}`,
          startRequestId: requestId,
          status: "exited",
        }),
      ],
    });
    provider.onCreate((request) =>
      makePod({
        id: "newcreated1",
        name: request.name,
        startRequestId: request.startRequestId,
        status: "provisioning",
      }),
    );
    const controller = makeController(provider);

    const result = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId,
    });

    assert.equal(result.outcome, "created");
    assert.equal(result.pod.id, "newcreated1");
    assert.deepEqual(result.snapshot.pods.map((pod) => pod.id), [
      "oldexited1",
      "newcreated1",
    ]);
    assert.ok(
      result.snapshot.warnings.some(
        (warning) => warning.code === "post_create_discovery_failed",
      ),
    );
  });

  it("preserves the created Pod's actual status when immediate discovery misses it", async (test) => {
    const variants = [
      ["error", "error"],
      ["exited", "offline"],
      ["unknown", "booting"],
    ] as const;
    for (const [status, expectedPhase] of variants) {
      await test.test(status, async () => {
        const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
        provider.onCreate((request) =>
          makePod({
            id: `${status}created1`,
            name: request.name,
            startRequestId: request.startRequestId,
            status,
          }),
        );
        const controller = makeController(provider);

        const result = await controller.startGpu({
          intent: "start_gpu",
          source: "foreground_user",
          requestId: `${status}result1`,
        });

        assert.equal(result.pod.lifecyclePhase, expectedPhase);
        assert.equal(result.snapshot.phase, expectedPhase);
      });
    }
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

  it("surfaces every worker boot phase on the freshly derived proxy", async () => {
    const pod = makePod({ id: "phasepod1", status: "provisioning" });
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()], pods: [pod] });
    const health = new FakeWorkerHealthProbe();
    const controller = makeController(provider, { health });
    const expectedProxy = deriveRunPodProxyUrl("phasepod1", 8000);
    const transitions = [
      { status: "provisioning" as const, phase: null, expected: "provisioning" as const },
      { status: "starting" as const, phase: null, expected: "booting" as const },
      { status: "running" as const, phase: "process" as const, expected: "booting" as const },
      { status: "running" as const, phase: "storage" as const, expected: "booting" as const },
      { status: "running" as const, phase: "weights" as const, expected: "loading" as const },
      { status: "running" as const, phase: "gpu_load" as const, expected: "loading" as const },
      { status: "running" as const, phase: "warmup" as const, expected: "warming" as const },
      { status: "running" as const, phase: "error" as const, expected: "error" as const },
      { status: "running" as const, phase: "ready" as const, expected: "ready" as const },
    ];

    for (const transition of transitions) {
      provider.setPods([makePod({ id: "phasepod1", status: transition.status })]);
      if (transition.phase !== null) {
        health.setHealth(expectedProxy, {
          schemaVersion: 1,
          phase: transition.phase,
          phaseProgress: transition.phase === "ready" ? 1 : 0.5,
        });
      }
      const snapshot = await controller.refresh();
      assert.equal(snapshot.phase, transition.expected);
      assert.equal(
        snapshot.error?.code ?? null,
        transition.phase === "error" ? "worker_boot_failed" : null,
      );
      assert.equal(snapshot.selectedPodId, "phasepod1");
      assert.equal(snapshot.proxyUrl, expectedProxy);
    }
    assert.equal(provider.calls.terminate.length, 0);
    assert.deepEqual(health.calls, Array(7).fill(expectedProxy));
  });

  it("does not reuse or replace a running Pod whose worker reports a boot error", async () => {
    const pod = makePod({ id: "workererror1", status: "running" });
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()], pods: [pod] });
    const health = new FakeWorkerHealthProbe();
    health.setHealth(pod.proxyUrl, {
      schemaVersion: 1,
      phase: "error",
      phaseProgress: 0,
    });
    const controller = makeController(provider, { health });

    await assert.rejects(
      () =>
        controller.startGpu({
          intent: "start_gpu",
          source: "foreground_user",
          requestId: "workererrorstart1",
        }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "operation_in_progress",
    );
    assert.equal(provider.calls.create.length, 0);
    assert.equal(controller.getSnapshot().phase, "error");
    assert.equal(controller.getSnapshot().error?.code, "operation_in_progress");
  });

  it("serializes a queued refresh behind an in-flight create", async () => {
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
    const createEntered = deferred();
    const releaseCreate = deferred();
    provider.onCreate(async () => {
      createEntered.resolve();
      await releaseCreate.promise;
      return undefined;
    });
    const controller = makeController(provider);
    const start = controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "serializedcreate1",
    });
    await createEntered.promise;

    const refresh = controller.refresh();
    await Promise.resolve();
    assert.equal(provider.calls.inventory.length, 1);
    assert.equal(provider.calls.list.length, 1);

    releaseCreate.resolve();
    const [started, refreshed] = await Promise.all([start, refresh]);
    assert.equal(started.pod.id, refreshed.selectedPodId);
    assert.equal(provider.calls.inventory.length, 2);
    assert.equal(provider.calls.list.length, 3);
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

  it("revalidates the exact managed Pod identity immediately before DELETE", async () => {
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [makePod({ id: "changedidentity1" })],
    });
    const controller = makeController(provider, { token: () => "identity-confirmation" });
    await controller.refresh();
    const confirmation = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: "changedidentity1",
    });
    provider.setPods([
      makePod({
        id: "changedidentity1",
        networkVolumeId: "someone-elses-volume",
      }),
    ]);

    await assert.rejects(
      () =>
        controller.stopGpu({
          intent: "confirm_stop_gpu",
          source: "foreground_user",
          podId: "changedidentity1",
          confirmationToken: confirmation.token,
        }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "pod_not_found",
    );
    assert.equal(provider.calls.get.length, 1);
    assert.equal(provider.calls.terminate.length, 0);
  });

  it("rejects expired and differently bound confirmations without terminating", async () => {
    let now = 0;
    let tokenNumber = 0;
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [makePod({ id: "boundpod1" }), makePod({ id: "otherpod2" })],
    });
    const controller = makeController(provider, {
      now: () => now,
      token: () => `bound-confirmation-${++tokenNumber}`,
    });
    await controller.refresh();

    const mismatched = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: "boundpod1",
    });
    await assert.rejects(
      () =>
        controller.stopGpu({
          intent: "confirm_stop_gpu",
          source: "foreground_user",
          podId: "otherpod2",
          confirmationToken: mismatched.token,
        }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "termination_target_mismatch",
    );

    const expiring = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: "boundpod1",
    });
    now = Date.parse(expiring.expiresAt);
    await assert.rejects(
      () =>
        controller.stopGpu({
          intent: "confirm_stop_gpu",
          source: "foreground_user",
          podId: "boundpod1",
          confirmationToken: expiring.token,
        }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "termination_confirmation_expired",
    );
    assert.equal(provider.calls.terminate.length, 0);
  });

  it("serializes a queued refresh behind an in-flight termination", async () => {
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [makePod({ id: "serializedstop1" })],
    });
    const terminateEntered = deferred();
    const releaseTerminate = deferred();
    provider.onTerminate(async () => {
      terminateEntered.resolve();
      await releaseTerminate.promise;
    });
    const controller = makeController(provider, { token: () => "serialized-confirmation" });
    await controller.refresh();
    const confirmation = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: "serializedstop1",
    });
    const stopping = controller.stopGpu({
      intent: "confirm_stop_gpu",
      source: "foreground_user",
      podId: "serializedstop1",
      confirmationToken: confirmation.token,
    });
    await terminateEntered.promise;

    const refresh = controller.refresh();
    await Promise.resolve();
    assert.equal(provider.calls.inventory.length, 1);
    assert.equal(provider.calls.list.length, 1);

    releaseTerminate.resolve();
    await Promise.all([stopping, refresh]);
    assert.equal(controller.getSnapshot().phase, "offline");
    assert.equal(provider.calls.inventory.length, 2);
    assert.equal(provider.calls.list.length, 2);
  });
});
