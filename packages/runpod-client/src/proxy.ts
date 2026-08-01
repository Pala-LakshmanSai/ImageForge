import { RunPodClientError } from "./errors.js";

// `<pod-id>-8000` must remain one valid DNS label (63 bytes maximum).
const POD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,57}$/;

export function deriveRunPodProxyUrl(podId: string, internalPort = 8000): string {
  if (!POD_ID.test(podId)) {
    throw new RunPodClientError({
      code: "api_response_invalid",
      message: "RunPod returned an invalid Pod identifier.",
      operation: "get_pod",
    });
  }
  if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65_535) {
    throw new RunPodClientError({
      code: "configuration_invalid",
      message: "The worker port must be an integer from 1 to 65535.",
      operation: "configuration",
      details: { field: "workerPort" },
    });
  }

  return `https://${podId}-${internalPort}.proxy.runpod.net`;
}
