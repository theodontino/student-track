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

function completionContent(prompt: string) {
  const step = stepPayload(prompt);
  if (step) return JSON.stringify(step);
  if (prompt.includes("课程材料整理助手")) {
    return JSON.stringify({ summary: "本阶段课程围绕核心概念、判断方法和综合应用逐步推进，并通过课堂任务与统一练习检查知识结构。" });
  }
  if (prompt.includes("反馈组装模型") || prompt.includes("反馈审核与润色模型") || prompt.includes("结构修复模型")) {
    return JSON.stringify(compositionPayload(prompt));
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
