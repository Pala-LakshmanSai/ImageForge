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

  it("blocks every later POST while an ambiguous create marker remains omitted", async () => {
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
    provider.failNext("create", new RunPodClientError({
      code: "api_network_error",
      message: "create response lost",
      operation: "create_pod",
      retryable: true,
      mayHaveSucceeded: true,
    }));
    const controller = makeController(provider);

    await assert.rejects(
      () => controller.startGpu({
        intent: "start_gpu",
        source: "foreground_user",
        requestId: "unresolvedmarker1",
      }),
      (error: unknown) => error instanceof RunPodClientError && error.code === "pod_create_ambiguous",
    );
    await assert.rejects(
      () => controller.startGpu({
        intent: "start_gpu",
        source: "foreground_user",
        requestId: "mustnotpost2",
      }),
      (error: unknown) => error instanceof RunPodClientError && error.code === "pod_create_ambiguous",
    );

    assert.equal(provider.calls.create.length, 1);
    const warning = controller.getSnapshot().warnings.find(
      (candidate) => candidate.code === "ambiguous_create_unresolved",
    );
    assert.deepEqual(warning?.podIds, []);

    provider.setPods([makePod({
      id: "reconciledmarkerpod1",
      name: "imageforge-unresolvedmarker1",
      startRequestId: "unresolvedmarker1",
      status: "provisioning",
    })]);
    const connected = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "stillmustnotpost3",
    });
    assert.equal(connected.outcome, "connected_existing");
    assert.equal(connected.pod.id, "reconciledmarkerpod1");
    assert.equal(provider.calls.create.length, 1);
    assert.equal(
      connected.snapshot.warnings.some((warning) => warning.code === "ambiguous_create_unresolved"),
      false,
    );
  });

  it("requires the exact foreground marker for explicit ambiguity resolution", async () => {
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
    provider.failNext("create", new RunPodClientError({
      code: "api_network_error",
      message: "create response lost",
      operation: "create_pod",
      mayHaveSucceeded: true,
    }));
    const controller = makeController(provider);
    await assert.rejects(() => controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "resolveexact1",
    }));
    assert.throws(() => controller.resolveAmbiguousCreate({
      intent: "resolve_ambiguous_create",
      source: "foreground_user",
      requestId: "wrongmarker2",
    }));
    controller.resolveAmbiguousCreate({
      intent: "resolve_ambiguous_create",
      source: "foreground_user",
      requestId: "resolveexact1",
    });
    const created = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "afterexplicit3",
    });
    assert.equal(created.outcome, "created");
    assert.equal(provider.calls.create.length, 2);
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

  it("keeps an ambiguous create latched when only a stale terminal marker exists", async () => {
    const requestId = "staleterminal1";
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [
        makePod({
          id: "oldterminal1",
          name: `imageforge-${requestId}`,
          startRequestId: requestId,
          status: "exited",
        }),
      ],
    });
    provider.failNext("create", new RunPodClientError({
      code: "api_network_error",
      message: "create response lost",
      operation: "create_pod",
      retryable: true,
      mayHaveSucceeded: true,
    }));
    const controller = makeController(provider);

    await assert.rejects(
      () => controller.startGpu({
        intent: "start_gpu",
        source: "foreground_user",
        requestId,
      }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "pod_create_ambiguous",
    );
    await assert.rejects(
      () => controller.startGpu({
        intent: "start_gpu",
        source: "foreground_user",
        requestId: "mustnotrepost2",
      }),
      (error: unknown) =>
        error instanceof RunPodClientError && error.code === "pod_create_ambiguous",
    );

    assert.equal(provider.calls.create.length, 1);
    assert.ok(
      controller.getSnapshot().warnings.some(
        (warning) => warning.code === "ambiguous_create_unresolved",
      ),
    );
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

  it("retains an omitted created Pod across a second explicit Start and never creates a duplicate", async () => {
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
    provider.onCreate((request) => makePod({
      id: "eventualcreated1",
      name: request.name,
      startRequestId: request.startRequestId,
      status: "provisioning",
    }));
    const controller = makeController(provider);

    const first = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "eventualrequest1",
    });
    const second = await controller.startGpu({
      intent: "start_gpu",
      source: "foreground_user",
      requestId: "mustnotcreate2",
    });

    assert.equal(first.pod.id, "eventualcreated1");
    assert.equal(second.outcome, "connected_existing");
    assert.equal(second.pod.id, "eventualcreated1");
    assert.equal(provider.calls.create.length, 1);
    assert.ok(second.snapshot.warnings.some(
      (warning) => warning.code === "post_create_discovery_failed" &&
        warning.podIds.includes("eventualcreated1"),
    ));
  });

  it("enforces a wall-clock wait bound and releases the mutation queue when inventory ignores abort", async () => {
    const provider = new FakeRunPodProvider({
      inventory: [makeOffer()],
      pods: [makePod({ id: "timeoutpod1", status: "provisioning" })],
    });
    const originalInventory = provider.listGpuInventory.bind(provider);
    provider.listGpuInventory = (() => new Promise(() => undefined)) as typeof provider.listGpuInventory;
    const controller = makeController(provider);
    const startedAt = Date.now();

    await assert.rejects(
      () => controller.waitUntilReady({ timeoutMs: 30, pollIntervalMs: 10 }),
      (error: unknown) => error instanceof RunPodClientError && error.code === "provisioning_timeout",
    );
    assert.ok(Date.now() - startedAt < 500);

    provider.listGpuInventory = originalInventory;
    const refreshed = await controller.refresh();
    assert.equal(refreshed.selectedPodId, "timeoutpod1");
  });

  it("gives public refresh its own deadline and releases the queue without a caller signal", async () => {
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
    const originalInventory = provider.listGpuInventory.bind(provider);
    provider.listGpuInventory = (() => new Promise(() => undefined)) as typeof provider.listGpuInventory;
    const controller = makeController(provider, {
      configOverrides: { operationTimeoutMs: 100 },
    });

    await assert.rejects(
      () => controller.refresh(),
      (error: unknown) =>
        error instanceof RunPodClientError &&
        error.code === "api_request_failed" &&
        error.operation === "list_pods",
    );
    provider.listGpuInventory = originalInventory;
    assert.equal((await controller.refresh()).phase, "offline");
  });

  it("bounds a never-resolving worker probe and propagates explicit health aborts", async () => {
    const pod = makePod({ id: "hunghealth1", status: "running" });
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()], pods: [pod] });
    const health = new FakeWorkerHealthProbe();
    health.getHealth = (() => new Promise(() => undefined)) as typeof health.getHealth;
    const controller = makeController(provider, { health });

    await assert.rejects(
      () => controller.waitUntilReady({ timeoutMs: 30, pollIntervalMs: 10 }),
      (error: unknown) => error instanceof RunPodClientError && error.code === "provisioning_timeout",
    );

    health.getHealth = (async () => {
      throw new RunPodClientError({
        code: "operation_aborted",
        message: "cancelled",
        operation: "worker_health",
      });
    }) as typeof health.getHealth;
    await assert.rejects(
      () => controller.refresh(),
      (error: unknown) => error instanceof RunPodClientError && error.code === "operation_aborted",
    );
    assert.equal(
      controller.getSnapshot().warnings.some((warning) => warning.code === "worker_health_unreachable"),
      false,
    );
  });

  it("bounds Pod list and retained-Pod get calls that ignore abort", async (test) => {
    await test.test("list discovery", async () => {
      const provider = new FakeRunPodProvider({
        inventory: [makeOffer()],
        pods: [makePod({ id: "hunglist1", status: "provisioning" })],
      });
      provider.listImageForgePods = (() => new Promise(() => undefined)) as typeof provider.listImageForgePods;
      const controller = makeController(provider);
      await assert.rejects(
        () => controller.waitUntilReady({ timeoutMs: 30, pollIntervalMs: 10 }),
        (error: unknown) => error instanceof RunPodClientError && error.code === "provisioning_timeout",
      );
    });

    await test.test("retained exact-ID get", async () => {
      const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
      provider.onCreate((request) => makePod({
        id: "hungknownget1",
        name: request.name,
        startRequestId: request.startRequestId,
        status: "provisioning",
      }));
      const controller = makeController(provider);
      await controller.startGpu({
        intent: "start_gpu",
        source: "foreground_user",
        requestId: "hungknownrequest1",
      });
      provider.getPod = (() => new Promise(() => undefined)) as typeof provider.getPod;
      await assert.rejects(
        () => controller.waitUntilReady({ timeoutMs: 30, pollIntervalMs: 10 }),
        (error: unknown) => error instanceof RunPodClientError && error.code === "provisioning_timeout",
      );
    });
  });

  it("bounds a create call that ignores abort and permits later queue progress", async () => {
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()] });
    provider.onCreate(() => new Promise(() => undefined));
    const controller = makeController(provider, {
      configOverrides: { provisioningTimeoutMs: 1_000 },
    });

    await assert.rejects(
      () => controller.startGpu({
        intent: "start_gpu",
        source: "foreground_user",
        requestId: "hungcreate1",
      }),
      (error: unknown) =>
        error instanceof RunPodClientError &&
        error.code === "provisioning_timeout" &&
        error.mayHaveSucceeded,
    );

    const refreshed = await controller.refresh();
    assert.equal(refreshed.phase, "offline");
    assert.equal(provider.calls.create.length, 1);
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

  it("settles an aborted termination whose provider never resolves and releases the queue", async () => {
    const pod = makePod({ id: "abortstop1" });
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()], pods: [pod] });
    const terminateEntered = deferred();
    provider.onTerminate(() => {
      terminateEntered.resolve();
      return new Promise(() => undefined);
    });
    const controller = makeController(provider, { token: () => "abort-stop-token" });
    await controller.refresh();
    const confirmation = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: pod.id,
    });
    const abort = new AbortController();
    const pending = controller.stopGpu({
      intent: "confirm_stop_gpu",
      source: "foreground_user",
      podId: pod.id,
      confirmationToken: confirmation.token,
    }, abort.signal);
    await terminateEntered.promise;
    abort.abort();

    await assert.rejects(
      () => pending,
      (error: unknown) =>
        error instanceof RunPodClientError &&
        error.code === "operation_aborted" &&
        error.mayHaveSucceeded,
    );
    assert.equal((await controller.refresh()).selectedPodId, pod.id);
  });

  it("does not attribute another queued stop's DELETE attempt to an aborted stop", async () => {
    const first = makePod({ id: "firstqueuedstop1", createdAt: "2026-08-01T00:00:00.000Z" });
    const second = makePod({ id: "secondqueuedstop2", createdAt: "2026-08-01T00:00:01.000Z" });
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()], pods: [first, second] });
    const firstDeleteEntered = deferred();
    provider.onTerminate((podId) => {
      if (podId === first.id) {
        firstDeleteEntered.resolve();
        return new Promise(() => undefined);
      }
      return undefined;
    });
    const tokens = ["first-stop-token", "second-stop-token"];
    const controller = makeController(provider, { token: () => tokens.shift() ?? "unused-token" });
    await controller.refresh();
    const firstConfirmation = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: first.id,
    });
    const secondConfirmation = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: second.id,
    });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const firstPending = controller.stopGpu({
      intent: "confirm_stop_gpu",
      source: "foreground_user",
      podId: first.id,
      confirmationToken: firstConfirmation.token,
    }, firstAbort.signal);
    await firstDeleteEntered.promise;
    const secondPending = controller.stopGpu({
      intent: "confirm_stop_gpu",
      source: "foreground_user",
      podId: second.id,
      confirmationToken: secondConfirmation.token,
    }, secondAbort.signal);
    secondAbort.abort();

    await assert.rejects(
      () => secondPending,
      (error: unknown) =>
        error instanceof RunPodClientError &&
        error.code === "operation_aborted" &&
        !error.mayHaveSucceeded &&
        error.details.podId === undefined,
    );
    assert.deepEqual(provider.calls.terminate, [first.id]);

    firstAbort.abort();
    await assert.rejects(() => firstPending);
  });

  it("gives confirmed stop its own deadline and treats an unresolved DELETE as ambiguous", async () => {
    const pod = makePod({ id: "timeoutstop1" });
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()], pods: [pod] });
    provider.onTerminate(() => new Promise(() => undefined));
    const controller = makeController(provider, {
      token: () => "timeout-stop-token",
      configOverrides: { operationTimeoutMs: 100 },
    });
    await controller.refresh();
    const confirmation = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: pod.id,
    });

    await assert.rejects(
      () => controller.stopGpu({
        intent: "confirm_stop_gpu",
        source: "foreground_user",
        podId: pod.id,
        confirmationToken: confirmation.token,
      }),
      (error: unknown) =>
        error instanceof RunPodClientError &&
        error.code === "pod_termination_failed" &&
        error.mayHaveSucceeded,
    );
    assert.equal(controller.getSnapshot().error?.code, "pod_termination_failed");
    assert.equal((await controller.refresh()).selectedPodId, pod.id);
  });

  it("times out stop revalidation without claiming an unattempted DELETE may have succeeded", async () => {
    const pod = makePod({ id: "timeoutgetstop1" });
    const provider = new FakeRunPodProvider({ inventory: [makeOffer()], pods: [pod] });
    const originalGet = provider.getPod.bind(provider);
    const controller = makeController(provider, {
      token: () => "timeout-get-stop-token",
      configOverrides: { operationTimeoutMs: 100 },
    });
    await controller.refresh();
    provider.getPod = (() => new Promise(() => undefined)) as typeof provider.getPod;
    const confirmation = controller.requestStopConfirmation({
      intent: "stop_gpu",
      source: "foreground_user",
      podId: pod.id,
    });

    await assert.rejects(
      () => controller.stopGpu({
        intent: "confirm_stop_gpu",
        source: "foreground_user",
        podId: pod.id,
        confirmationToken: confirmation.token,
      }),
      (error: unknown) =>
        error instanceof RunPodClientError &&
        error.code === "pod_discovery_failed" &&
        error.operation === "get_pod" &&
        !error.mayHaveSucceeded,
    );
    assert.equal(provider.calls.terminate.length, 0);
    provider.getPod = originalGet;
    assert.equal((await controller.refresh()).selectedPodId, pod.id);
  });
});
