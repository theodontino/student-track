import { NextResponse } from "next/server";
import packageMetadata from "../../../../../../package.json";
import {
  SYSTEM_API_VERSION,
  SYSTEM_CAPABILITIES,
  SystemHealthResponseSchema,
} from "@/lib/contracts/system";

export function GET() {
  const body = SystemHealthResponseSchema.parse({
    schemaVersion: 1,
    product: "student-track",
    appVersion: packageMetadata.version,
    apiVersion: SYSTEM_API_VERSION,
    status: "ok",
    capabilities: [...SYSTEM_CAPABILITIES].sort(),
  });

  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
