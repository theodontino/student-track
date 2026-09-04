import ProductFeatureUnavailable from "@/components/ProductFeatureUnavailable";
import DiarizeWorkspace from "@/features/entry/DiarizeWorkspace";
import { getProductCapabilities } from "@/lib/product-edition";

export default function DiarizePage() {
  if (!getProductCapabilities().audioTranscription) {
    return <ProductFeatureUnavailable featureName="录音转写" />;
  }
  return <DiarizeWorkspace />;
}
