export const LOWERCASE_REGISTRY_IMAGE_DIGEST_V1 =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::(?:[1-9][0-9]{0,4}))?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/;

export function isLowercaseRegistryImageDigestV1(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= 512 &&
    LOWERCASE_REGISTRY_IMAGE_DIGEST_V1.test(value);
}
