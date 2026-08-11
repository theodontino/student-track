// Keep the explicit bridge URL stable while the class route remains backward compatible.
import { GET as exportStepRoster } from "../route";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return exportStepRoster(request, context);
}
