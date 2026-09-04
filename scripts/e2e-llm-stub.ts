import http from "node:http";

type StubMode = "normal" | "fail";

function readBody(request: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("E2E LLM request is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function textFromRequest(body: string) {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
    return (parsed.messages ?? []).map((message) => typeof message.content === "string" ? message.content : "").join("\n");
  } catch {
    return "";
  }
}

function stepPayload(prompt: string) {
  const match = prompt.match(/=== DATA BEGIN ===\s*([\s\S]*?)\s*=== DATA END ===/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]) as {
      students?: Array<{
        studentId?: string;
        name?: string;
        present?: boolean;
        observations?: Array<{ semanticText?: string; followUpAction?: string | null }>;
        notes?: Array<{ text?: string } | string>;
      }>;
    };
    return {
      students: (data.students ?? []).map((student) => ({
        name: student.name ?? "测试学生",
        studentId: student.studentId,
        scores: { A: null, B: null, C: null },
        events: (student.observations ?? []).map((observation) => [observation.semanticText, observation.followUpAction].filter(Boolean).join("；")).filter(Boolean),
        communication: null,
        ...(typeof student.present === "boolean" ? { present: student.present } : {}),
      })),
      alert_suggestion: "",
    };
  } catch {
    return null;
  }
}

function compositionPayload(prompt: string) {
  const closureLine = prompt.match(/closureType 只有：([^。\n]+)/)?.[1] ?? "positive_recognition";
  const closureType = closureLine.split(/[,，]/).map((value) => value.trim()).find(Boolean) ?? "positive_recognition";
  return {
    version: 1,
    closureType,
    needParentAction: false,
    parentAction: null,
    modules: [],
    evidenceCoverage: [],
    draftFeedback: "家长您好，本阶段课堂学习过程与关键表现已经完成记录。孩子能够参与课堂任务，也有需要继续复盘和巩固的部分，请以老师最终复核后的反馈为准。",
  };
}

function jsonSection<T>(prompt: string, startMarker: string, endMarker: string): T | null {
  const start = prompt.indexOf(startMarker);
  if (start < 0) return null;
  const contentStart = start + startMarker.length;
  const end = prompt.indexOf(endMarker, contentStart);
  if (end < 0) return null;
  try {
    return JSON.parse(prompt.slice(contentStart, end).trim()) as T;
  } catch {
    return null;
  }
}

interface RestrictedPlannerBoundary {
  outputRequirement?: string;
  generationPreferences?: { closureType?: string } | null;
  allowedModules?: string[];
  allowedClosures?: string[];
  planType?: string;
}

interface RestrictedEvidenceItem {
  id?: string;
  kind?: string;
  content?: string;
}

interface RestrictedEvidenceBundle {
  teachingEvidence?: RestrictedEvidenceItem[];
  assessmentEvidence?: RestrictedEvidenceItem[];
  teachingBackground?: string[];
}

interface RestrictedSourceIndexItem {
  ref?: string;
  origin?: string;
  canDiscloseToWriter?: boolean;
}

function restrictedPlannerPayload(prompt: string) {
  const boundary = jsonSection<RestrictedPlannerBoundary>(prompt, "计划边界：\n", "\n\n冻结证据：") ?? {};
  const evidence = jsonSection<RestrictedEvidenceBundle>(prompt, "冻结证据：\n", "\n\n可引用来源索引：") ?? {};
  const sourceIndex = jsonSection<RestrictedSourceIndexItem[]>(prompt, "可引用来源索引：\n", "\n\n只返回合法 JSON：") ?? [];
  const evidenceItems = [...(evidence.teachingEvidence ?? []), ...(evidence.assessmentEvidence ?? [])];
  const disclosable = sourceIndex.filter((item) => item.canDiscloseToWriter && typeof item.ref === "string");
  const preferredOrigins = boundary.planType === "class_update"
    ? ["teaching_background", "output_requirement", "teaching_evidence", "assessment_evidence"]
    : ["teaching_evidence", "assessment_evidence", "teaching_background", "output_requirement"];
  const source = preferredOrigins.flatMap((origin) => disclosable.filter((item) => item.origin === origin))[0]
    ?? disclosable[0];
  const ref = source?.ref ?? "teacher-output-requirement";
  const indexedEvidence = evidenceItems.find((item) => item.id === ref);
  const backgroundIndex = ref.startsWith("teaching-background:")
    ? Number(ref.slice("teaching-background:".length)) - 1
    : -1;
  const content = indexedEvidence?.content
    ?? (backgroundIndex >= 0 ? evidence.teachingBackground?.[backgroundIndex] : undefined)
    ?? boundary.outputRequirement
    ?? "根据已确认事实形成反馈";
  const kind = source?.origin === "teaching_background"
    ? "teaching_background"
    : source?.origin === "output_requirement"
      ? "teacher_instruction"
      : indexedEvidence?.kind === "fact" ? "fact" : "interpretation";
  const allowedModules = boundary.allowedModules?.filter(Boolean) ?? [];
  const allowedClosures = boundary.allowedClosures?.filter(Boolean) ?? [];
  const requestedClosure = boundary.generationPreferences?.closureType;
  const closureType = requestedClosure && allowedClosures.includes(requestedClosure)
    ? requestedClosure
    : allowedClosures[0] ?? "positive_recognition";
  const needParentAction = closureType === "home_cooperation";
  const moduleKey = needParentAction && allowedModules.includes("parent_action")
    ? "parent_action"
    : allowedModules.find((key) => key !== "parent_action") ?? allowedModules[0] ?? "observed_moment";
  return {
    version: 1,
    mainFocus: "根据已确认且允许披露的内容形成简洁反馈",
    closureType,
    points: [{ id: "P1", moduleKey, kind, content, evidenceRefs: [ref], confidence: "high" }],
    contextOnly: [],
    omit: [],
    communicationIntent: "向家长清楚说明已确认的学习情况",
    needParentAction,
    parentAction: needParentAction ? {
      type: "remind",
      actionBrief: "按反馈内容完成一次简短复盘",
      successCriteriaBrief: "能够说明本次学习要点",
      notNeededBrief: "已经掌握时无需重复练习",
      pointIds: ["P1"],
    } : null,
    unresolved: [],
  };
}

interface RestrictedWriterDisclosure {
  id?: string;
  moduleKey?: string;
  content?: string;
}

interface RestrictedWriterInput {
  studentName?: string;
  disclosures?: RestrictedWriterDisclosure[];
  parentAction?: { type?: string; disclosureIds?: string[] } | null;
}

function restrictedWriterPayload(prompt: string) {
  const input = jsonSection<RestrictedWriterInput>(prompt, "受限输入：\n", "\n\n只返回合法 JSON：") ?? {};
  const disclosure = input.disclosures?.find((item) => item.id && item.moduleKey && item.content) ?? {
    id: "D1",
    moduleKey: "observed_moment",
    content: "本次课堂学习情况已经完成记录",
  };
  const statement = disclosure.content!;
  const modulePayload = {
    key: disclosure.moduleKey!,
    content: statement,
    disclosureIds: [disclosure.id!],
  };
  const parentAction = input.parentAction ? {
    action: "请按反馈内容完成一次简短复盘",
    successCriteria: "能够说明本次学习要点",
    notNeeded: "已经掌握时无需重复练习",
  } : null;
  return {
    version: 1,
    modules: [modulePayload],
    coverage: [{ disclosureId: disclosure.id!, statement }],
    parentAction,
    draftFeedback: `${input.studentName ?? "学生"}家长您好，${statement}。`,
  };
}

function completionContent(prompt: string) {
  const step = stepPayload(prompt);
  if (step) return JSON.stringify(step);
  if (prompt.includes("课程材料整理助手")) {
    return JSON.stringify({ summary: "本阶段课程围绕核心概念、判断方法和综合应用逐步推进，并通过课堂任务与统一练习检查知识结构。" });
  }
  if (prompt.includes("反馈组装模型") || prompt.includes("反馈审核与润色模型") || prompt.includes("结构修复模型")) {
    return JSON.stringify(compositionPayload(prompt));
  }
  if (prompt.includes("Student Track 的反馈 Planner")) {
    return JSON.stringify(restrictedPlannerPayload(prompt));
  }
  if (prompt.includes("Student Track 的反馈 Writer")) {
    return JSON.stringify(restrictedWriterPayload(prompt));
  }
  if (prompt.includes("revised_scores") || prompt.includes("revised_events")) {
    return JSON.stringify({ is_valid: true, issues: [], suggestions: [], revised_scores: {}, revised_events: {}, revised_teacher_interventions: {} });
  }
  if (prompt.includes("corrections") && prompt.includes("corrected")) {
    return JSON.stringify({ corrections: [] });
  }
  return JSON.stringify({
    verdict: "pass",
    feedback: "家长您好，本阶段学习情况已经完成整理，请以教师最终复核后的反馈为准。",
    issues: [],
  });
}

function json(response: http.ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

export async function startE2ELlmStub(options: { delayMs?: number } = {}) {
  let mode: StubMode = "normal";
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      json(response, 200, { object: "list", data: [{ id: "test-course-cycle-model", object: "model" }] });
      return;
    }
    if (request.method === "POST" && request.url === "/control") {
      const body = JSON.parse(await readBody(request)) as { mode?: StubMode };
      mode = body.mode === "fail" ? "fail" : "normal";
      json(response, 200, { mode });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      json(response, 404, { error: { message: "E2E stub route not found" } });
      return;
    }
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (mode === "fail") {
      json(response, 503, { error: { message: "E2E forced LLM failure", type: "e2e_failure" } });
      return;
    }
    const prompt = textFromRequest(await readBody(request));
    json(response, 200, {
      id: "test-course-cycle-completion",
      object: "chat.completion",
      created: 0,
      model: "test-course-cycle-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: completionContent(prompt) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("E2E LLM stub did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
