import { ApiError } from "@/lib/api-errors";
import {
  hasProductCapability,
  type ProductCapability,
} from "@/lib/product-edition";

export const FEATURE_UNAVAILABLE_MESSAGE = "当前 Core 版未包含此功能";

export function assertProductCapability(capability: ProductCapability) {
  if (!hasProductCapability(capability)) {
    throw new ApiError(FEATURE_UNAVAILABLE_MESSAGE, 404, "feature_unavailable", false);
  }
}
