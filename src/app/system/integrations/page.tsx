import ProductFeatureUnavailable from "@/components/ProductFeatureUnavailable";
import IntegrationsPanel from "@/features/system/IntegrationsPanel";
import { getProductCapabilities } from "@/lib/product-edition";

export default function Page() {
  if (!getProductCapabilities().integrationSettings) {
    return <ProductFeatureUnavailable featureName="集成与本地工具" />;
  }
  return <IntegrationsPanel />;
}
