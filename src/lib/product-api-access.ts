import {
  getProductCapabilities,
  type ProductCapabilities,
  type ProductCapability,
} from "@/lib/product-edition";

export const PRODUCT_RESTRICTED_API_PREFIXES: ReadonlyArray<Readonly<{
  prefix: string;
  capability: ProductCapability;
}>> = [
  { prefix: "/api/diarize", capability: "audioTranscription" },
  { prefix: "/api/wecom", capability: "wecomIntegration" },
  { prefix: "/api/integrations/wecomcatch/v1/directory", capability: "wecomIntegration" },
  { prefix: "/api/system/local-tools", capability: "localToolStatus" },
];

function pathMatchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
export function requiredProductCapabilityForApiPath(pathname: string): ProductCapability | null {
  return PRODUCT_RESTRICTED_API_PREFIXES.find(({ prefix }) => pathMatchesPrefix(pathname, prefix))?.capability ?? null;
}

export function isProductApiPathAvailable(
  pathname: string,
  capabilities: ProductCapabilities = getProductCapabilities(),
) {
  const capability = requiredProductCapabilityForApiPath(pathname);
  return capability === null || capabilities[capability];
}
