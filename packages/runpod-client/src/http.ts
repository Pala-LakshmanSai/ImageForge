import { RunPodClientError, type RunPodOperation } from "./errors.js";

export type ApiKeyProvider = () => Promise<string> | string;
export type FetchTransport = typeof fetch;

export interface AuthorizedRequestOptions {
  readonly method: "GET" | "POST" | "DELETE";
  readonly operation: RunPodOperation;
  readonly expectedStatuses: readonly number[];
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

function awaitAuthorizedAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  operation: RunPodOperation,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    return Promise.reject(new RunPodClientError({
      code: "operation_aborted",
      message: "The RunPod operation was cancelled.",
      operation,
    }));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new RunPodClientError({
      code: "operation_aborted",
      message: "The RunPod operation was cancelled.",
      operation,
    }));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export function validateBaseUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RunPodClientError({
      code: "configuration_invalid",
      message: `${field} must be a valid HTTPS URL.`,
      operation: "configuration",
      details: { field },
    });
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new RunPodClientError({
      code: "configuration_invalid",
      message: `${field} must be an HTTPS URL without credentials, query parameters, or fragments.`,
      operation: "configuration",
      details: { field },
    });
  }

  return url.toString().replace(/\/$/, "");
}

export type RunPodApiSurface = "lifecycle" | "inventory";

/** Pins bearer credentials to the two reviewed RunPod API surfaces. */
export function validateRunPodBaseUrl(
  value: string,
  field: string,
  surface: RunPodApiSurface,
): string {
  const normalized = validateBaseUrl(value, field);
  const url = new URL(normalized);
  const expectedHost = surface === "lifecycle" ? "rest.runpod.io" : "api.runpod.io";
  const expectedPath = surface === "lifecycle" ? "/v1" : "/v2";
  if (url.hostname !== expectedHost || url.port !== "" || url.pathname !== expectedPath) {
    throw new RunPodClientError({
      code: "configuration_invalid",
      message: `${field} must use the official RunPod ${surface} endpoint.`,
      operation: "configuration",
      details: { field },
    });
  }
  return normalized;
}

function errorForHttpStatus(
  status: number,
  operation: RunPodOperation,
  retryAfter: string | null,
): RunPodClientError {
  const details: Record<string, string | number | boolean | null> = { status };
  if (retryAfter !== null) {
    details.retryAfter = retryAfter;
  }

  if (status === 401) {
    return new RunPodClientError({
      code: "api_authentication_failed",
      message: "RunPod rejected the configured API credential.",
      operation,
      httpStatus: status,
      details,
    });
  }
  if (status === 403) {
    return new RunPodClientError({
      code: "api_permission_denied",
      message: "The RunPod credential does not permit this operation.",
      operation,
      httpStatus: status,
      details,
    });
  }
  if (status === 429) {
    return new RunPodClientError({
      code: "api_rate_limited",
      message: "RunPod is rate limiting requests. Try again after the reported delay.",
      operation,
      retryable: true,
      mayHaveSucceeded: operation === "create_pod" || operation === "terminate_pod",
      httpStatus: status,
      details,
    });
  }
  if (operation === "create_pod" && status === 409) {
    return new RunPodClientError({
      code: "gpu_unavailable",
      message: "The selected RunPod offer became unavailable before creation completed.",
      operation,
      retryable: true,
      httpStatus: status,
      details,
    });
  }
  if (operation === "create_pod" && (status === 400 || status === 422)) {
    return new RunPodClientError({
      code: "pod_create_rejected",
      message: "RunPod rejected the Pod configuration.",
      operation,
      httpStatus: status,
      details,
    });
  }
  if (operation === "terminate_pod" && status === 404) {
    return new RunPodClientError({
      code: "pod_not_found",
      message: "The selected RunPod Pod no longer exists.",
      operation,
      httpStatus: status,
      details,
    });
  }

  return new RunPodClientError({
    code: "api_request_failed",
    message: status >= 500 ? "RunPod is temporarily unavailable." : "RunPod rejected the request.",
    operation,
    retryable: status >= 500,
    mayHaveSucceeded:
      status >= 500 && (operation === "create_pod" || operation === "terminate_pod"),
    httpStatus: status,
    details,
  });
}

export class AuthorizedRestClient {
  readonly #apiKeyProvider: ApiKeyProvider;
  readonly #fetch: FetchTransport;

  constructor(apiKeyProvider: ApiKeyProvider, fetchTransport: FetchTransport = fetch) {
    this.#apiKeyProvider = apiKeyProvider;
    this.#fetch = fetchTransport;
  }

  async request(url: string, options: AuthorizedRequestOptions): Promise<Response> {
    let apiKey: string;
    try {
      apiKey = await awaitAuthorizedAbort(
        Promise.resolve(this.#apiKeyProvider()),
        options.signal,
        options.operation,
      );
    } catch (error) {
      if (error instanceof RunPodClientError && error.code === "operation_aborted") {
        throw error;
      }
      throw new RunPodClientError({
        code: "credential_unavailable",
        message: "The RunPod credential could not be loaded from secure storage.",
        operation: options.operation,
      });
    }
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      throw new RunPodClientError({
        code: "credential_unavailable",
        message: "No RunPod credential is configured in secure storage.",
        operation: options.operation,
      });
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await awaitAuthorizedAbort(this.#fetch(url, {
        method: options.method,
        headers,
        redirect: "error",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }), options.signal, options.operation);
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new RunPodClientError({
          code: "operation_aborted",
          message: "The RunPod operation was cancelled.",
          operation: options.operation,
        });
      }
      throw new RunPodClientError({
        code: "api_network_error",
        message: "RunPod could not be reached over the network.",
        operation: options.operation,
        retryable: true,
        mayHaveSucceeded:
          options.operation === "create_pod" || options.operation === "terminate_pod",
        cause: error,
      });
    }

    if (!options.expectedStatuses.includes(response.status)) {
      throw errorForHttpStatus(
        response.status,
        options.operation,
        response.headers.get("retry-after"),
      );
    }
    return response;
  }

  async requestJson(url: string, options: AuthorizedRequestOptions): Promise<unknown> {
    const response = await this.request(url, options);
    try {
      return await response.json();
    } catch (error) {
      throw new RunPodClientError({
        code: "api_response_invalid",
        message: "RunPod returned malformed JSON.",
        operation: options.operation,
        httpStatus: response.status,
        cause: error,
      });
    }
  }
}
