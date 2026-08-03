export type StopGuardErrorCode =
  | "stop_blocked_by_active_batch"
  | "stop_consent_pending"
  | "stop_consent_denied"
  | "stop_consent_expired"
  | "gpu_stop_pending"
  | "stop_guard_failed";

export type RunPodErrorCode =
  | "configuration_invalid"
  | "credential_unavailable"
  | "api_network_error"
  | "api_authentication_failed"
  | "api_permission_denied"
  | "api_rate_limited"
  | "api_request_failed"
  | "api_response_invalid"
  | "inventory_unavailable"
  | "gpu_unavailable"
  | "no_gpu_available"
  | "pod_create_rejected"
  | "pod_create_ambiguous"
  | "pod_discovery_failed"
  | "pod_not_found"
  | "provisioning_failed"
  | "provisioning_timeout"
  | "operation_in_progress"
  | "termination_confirmation_required"
  | "termination_confirmation_expired"
  | "termination_target_mismatch"
  | "pod_termination_failed"
  | "operation_aborted"
  | StopGuardErrorCode;

export type RunPodOperation =
  | "configuration"
  | "inventory"
  | "list_pods"
  | "get_pod"
  | "get_template"
  | "create_pod"
  | "worker_health"
  | "terminate_pod"
  | "wait_for_ready";

export interface RunPodClientErrorOptions {
  readonly code: RunPodErrorCode;
  readonly message: string;
  readonly operation: RunPodOperation;
  readonly retryable?: boolean;
  readonly mayHaveSucceeded?: boolean;
  readonly httpStatus?: number;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  readonly cause?: unknown;
}

/**
 * A safe, typed operational error. `details` must never contain credentials,
 * request headers, response bodies, template environment values, or prompts.
 */
export class RunPodClientError extends Error {
  readonly code: RunPodErrorCode;
  readonly operation: RunPodOperation;
  readonly retryable: boolean;
  readonly mayHaveSucceeded: boolean;
  readonly httpStatus: number | null;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(options: RunPodClientErrorOptions) {
    // Never retain an upstream exception. Fetch/JSON errors can embed request
    // headers or response snippets in their message and ordinary error
    // inspection includes Error.cause even when JSON serialization does not.
    super(options.message);
    this.name = "RunPodClientError";
    this.code = options.code;
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
    this.mayHaveSucceeded = options.mayHaveSucceeded ?? false;
    this.httpStatus = options.httpStatus ?? null;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      operation: this.operation,
      retryable: this.retryable,
      mayHaveSucceeded: this.mayHaveSucceeded,
      httpStatus: this.httpStatus,
      details: this.details,
    };
  }
}

export function isRunPodClientError(error: unknown): error is RunPodClientError {
  return error instanceof RunPodClientError;
}

export function asRunPodClientError(
  error: unknown,
  fallback: Omit<RunPodClientErrorOptions, "cause">,
): RunPodClientError {
  if (isRunPodClientError(error)) {
    return error;
  }

  return new RunPodClientError({ ...fallback, cause: error });
}
