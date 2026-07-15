"use client";

import { useState } from "react";
import WeComBridgePanel from "./WeComBridgePanel";
import WeComCatchPanel from "./WeComCatchPanel";
import WeComImportPreview from "./WeComImportPreview";
import type { WeComImportResult } from "./types";

interface WeComWorkflowPanelProps {
  title?: string;
  description?: string;
  showFeedbackLink?: boolean;
  onApplied?: (result: WeComImportResult) => void;
}

export default function WeComWorkflowPanel({
  title = "企微家校沟通工作流",
  description = "同步、提取、预览并导入会影响课后反馈的家校沟通。",
  showFeedbackLink = false,
  onApplied,
}: WeComWorkflowPanelProps) {
  const [bridgeText, setBridgeText] = useState("");
  const [generatedJsonText, setGeneratedJsonText] = useState("");
  const [generatedFileName, setGeneratedFileName] = useState("");
  const [generatedVersion, setGeneratedVersion] = useState(0);

  function acceptGeneratedJson(jsonText: string, fileName: string) {
    setGeneratedJsonText(jsonText);
    setGeneratedFileName(fileName);
    setGeneratedVersion((current) => current + 1);
  }

  return (
    <section className="wecom-workflow min-w-0 space-y-4">
      <div>
        <h3 className="font-semibold text-gray-800">{title}</h3>
        <p className="text-sm text-gray-500 mt-1">{description}</p>
      </div>

      <WeComCatchPanel
        onExportText={setBridgeText}
        showFeedbackLink={showFeedbackLink}
      />
      <WeComBridgePanel
        sourceText={bridgeText}
        onSourceTextChange={setBridgeText}
        onGenerated={acceptGeneratedJson}
      />
      <WeComImportPreview
        externalJsonText={generatedJsonText}
        externalFileName={generatedFileName}
        externalVersion={generatedVersion}
        onApplied={onApplied}
      />
    </section>
  );
}
