import ProductFeatureUnavailable from "@/components/ProductFeatureUnavailable";
import WeComWorkspace from "@/features/wecom/WeComWorkspace";
import { getProductCapabilities } from "@/lib/product-edition";

export default function Page() {
  if (!getProductCapabilities().wecomIntegration) {
    return <ProductFeatureUnavailable featureName="企微家校" />;
  }
  return <WeComWorkspace />;
}
