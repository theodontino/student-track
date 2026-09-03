import { NextResponse, type NextRequest } from "next/server";
import { isAllowedLocalApiRequest } from "@/lib/local-api-request";
import { FEATURE_UNAVAILABLE_MESSAGE } from "@/lib/product-capability-guard";
import { isProductApiPathAvailable } from "@/lib/product-api-access";

export function proxy(request: NextRequest) {
  const host = request.headers.get("host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol || request.nextUrl.protocol.replace(/:$/, "");
  const requestOrigin = host ? `${protocol}://${host}` : request.nextUrl.origin;
  const allowed = isAllowedLocalApiRequest({
    requestOrigin,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    host,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "本地接口仅接受同源回环请求", code: "forbidden_origin", retryable: false },
      { status: 403 },
    );
  }
  if (!isProductApiPathAvailable(request.nextUrl.pathname)) {
    return NextResponse.json(
      { error: FEATURE_UNAVAILABLE_MESSAGE, code: "feature_unavailable", retryable: false },
      { status: 404 },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
