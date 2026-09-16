import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiErrorBody, safeApiError } from "@/lib/api-errors";
import { assertProductCapability } from "@/lib/product-capability-guard";
import { hasProductCapability } from "@/lib/product-edition";
import {
  activateLLMProfile,
  clearLLMSettings,
  deleteLLMProfile,
  getEffectiveLLMSettings,
  getLLMSettingsStore,
  saveLLMProfile,
  saveLLMRoleAssignments,
  validateLLMSettings,
  type LLMRoleAssignments,
  type LLMSettingsStore,
} from "@/lib/llm-settings";

function visibleStore(store: LLMSettingsStore): LLMSettingsStore {
  if (hasProductCapability("wecomExtraction")) return store;
  return {
    ...store,
    roleAssignments: {
      ...store.roleAssignments,
      wecomExtractionProfileId: null,
    },
  };
}

function settingsResponse(store: LLMSettingsStore) {
  return NextResponse.json({
    ...visibleStore(store),
    effectiveSettings: getEffectiveLLMSettings(),
  });
}

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    const failure = error.status >= 500 ? safeApiError(error, fallback) : error;
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
  return NextResponse.json(
    { error: error instanceof Error && error.message ? error.message : fallback },
    { status: 400 },
  );
}

export async function GET() {
  return settingsResponse(getLLMSettingsStore());
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const store = saveLLMProfile(body, body.activate !== false);
    return settingsResponse(store);
  } catch (error) {
    return errorResponse(error, "保存 LLM 设置失败");
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json() as {
      activeProfileId?: string;
      roleAssignments?: Partial<LLMRoleAssignments>;
    };
    let store: LLMSettingsStore;
    if (body.roleAssignments) {
      if (!hasProductCapability("wecomExtraction")) {
        if (Object.prototype.hasOwnProperty.call(body.roleAssignments, "wecomExtractionProfileId")) {
          assertProductCapability("wecomExtraction");
        }
        const current = getLLMSettingsStore();
        store = saveLLMRoleAssignments({
          ...body.roleAssignments,
          wecomExtractionProfileId: current.roleAssignments.wecomExtractionProfileId,
        });
      } else {
        store = saveLLMRoleAssignments(body.roleAssignments);
      }
    } else {
      store = activateLLMProfile(body.activeProfileId as string);
    }
    return settingsResponse(store);
  } catch (error) {
    return errorResponse(error, "更新 LLM 配置失败");
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) {
      clearLLMSettings();
      return settingsResponse(getLLMSettingsStore());
    }
    const store = deleteLLMProfile(id);
    return settingsResponse(store);
  } catch (error) {
    return errorResponse(error, "删除 LLM 配置失败");
  }
}

export async function POST(request: NextRequest) {
  let settings: ReturnType<typeof validateLLMSettings>;
  try {
    const body = await request.json();
    settings = validateLLMSettings(body);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error && error.message ? error.message : "LLM 配置无效" },
      { status: 400 },
    );
  }

  try {
    const response = await fetch(`${settings.apiBaseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      cache: "no-store",
    });

    if (!response.ok) {
      const failure = safeApiError(
        new ApiError(`连接失败：HTTP ${response.status}`, 502, "llm_service_error", true),
        "LLM 服务暂时不可用",
      );
      return NextResponse.json(
        { ok: false, ...apiErrorBody(failure) },
        { status: failure.status },
      );
    }

    const data = await response.json();
    const models = Array.isArray(data?.data) ? data.data.map((item: any) => item.id).filter(Boolean) : [];
    return NextResponse.json({ ok: true, models });
  } catch {
    const failure = safeApiError(
      new ApiError("测试连接失败", 502, "llm_service_error", true),
      "测试连接失败",
    );
    return NextResponse.json({ ok: false, ...apiErrorBody(failure) }, { status: failure.status });
  }
}
