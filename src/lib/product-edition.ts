export const PRODUCT_EDITIONS = ["core", "full"] as const;

export type ProductEdition = typeof PRODUCT_EDITIONS[number];

export type ProductCapabilities = Readonly<{
  edition: ProductEdition;
  audioTranscription: boolean;
  integrationSettings: boolean;
  localToolStatus: boolean;
  wecomDraftExport: boolean;
  wecomExtraction: boolean;
  wecomIntegration: boolean;
}>;

export type ProductCapability = Exclude<keyof ProductCapabilities, "edition">;

const CAPABILITIES_BY_EDITION: Readonly<Record<ProductEdition, ProductCapabilities>> = {
  core: Object.freeze({
    edition: "core",
    audioTranscription: false,
    integrationSettings: false,
    localToolStatus: false,
    wecomDraftExport: false,
    wecomExtraction: false,
    wecomIntegration: false,
  }),
  full: Object.freeze({
    edition: "full",
    audioTranscription: true,
    integrationSettings: true,
    localToolStatus: true,
    wecomDraftExport: true,
    wecomExtraction: true,
    wecomIntegration: true,
  }),
};

export const PRODUCT_EDITION_LABELS: Readonly<Record<ProductEdition, "Core" | "Full">> = {
  core: "Core",
  full: "Full",
};

export function parseProductEdition(value: string | undefined): ProductEdition {
  if (value === undefined) return "full";
  if (value === "core" || value === "full") return value;
  throw new Error(`STUDENT_TRACK_EDITION 必须是 core 或 full，当前值为 ${JSON.stringify(value)}`);
}

export function productCapabilitiesFor(edition: ProductEdition): ProductCapabilities {
  return CAPABILITIES_BY_EDITION[edition];
}

/**
 * `next.config.ts` injects this build identity into both server and browser
 * bundles, so the two sides cannot observe different editions.
 */
export function getProductEdition(): ProductEdition {
  return parseProductEdition(process.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION);
}

export function getProductCapabilities(): ProductCapabilities {
  return productCapabilitiesFor(getProductEdition());
}

export function hasProductCapability(capability: ProductCapability): boolean {
  return getProductCapabilities()[capability];
}
