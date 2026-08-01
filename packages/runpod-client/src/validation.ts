import { RunPodClientError, type RunPodOperation } from "./errors.js";

function invalid(operation: RunPodOperation, field: string): never {
  throw new RunPodClientError({
    code: "api_response_invalid",
    message: "RunPod returned an unexpected response shape.",
    operation,
    details: { field },
  });
}

export function asRecord(
  value: unknown,
  operation: RunPodOperation,
  field = "response",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(operation, field);
  }
  return value as Record<string, unknown>;
}

export function asArray(
  value: unknown,
  operation: RunPodOperation,
  field: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalid(operation, field);
  }
  return value;
}

export function asString(
  value: unknown,
  operation: RunPodOperation,
  field: string,
): string {
  if (typeof value !== "string") {
    invalid(operation, field);
  }
  return value;
}

export function asNonEmptyString(
  value: unknown,
  operation: RunPodOperation,
  field: string,
): string {
  const result = asString(value, operation, field);
  if (result.length === 0) {
    invalid(operation, field);
  }
  return result;
}

export function asNumber(
  value: unknown,
  operation: RunPodOperation,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(operation, field);
  }
  return value;
}

export function asBoolean(
  value: unknown,
  operation: RunPodOperation,
  field: string,
): boolean {
  if (typeof value !== "boolean") {
    invalid(operation, field);
  }
  return value;
}

export function asNullableString(
  value: unknown,
  operation: RunPodOperation,
  field: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asString(value, operation, field);
}

export function asNullableFiniteNumber(
  value: unknown,
  operation: RunPodOperation,
  field: string,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  invalid(operation, field);
}
