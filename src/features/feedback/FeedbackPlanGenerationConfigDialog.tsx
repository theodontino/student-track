"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button, Dialog, FormField, Select, StatusBanner, Textarea } from "@/components/ui";
import {
  FEEDBACK_CLOSURES_BY_TYPE,
  FEEDBACK_MODULES,
  STUDENT_FEEDBACK_PLAN_TYPES,
  defaultFeedbackGenerationPreferences,
  type FeedbackClosureType,
  type FeedbackPlanItemGenerationConfig,
  type StudentFeedbackPlanType,
} from "@/lib/feedback-plan";

const typeLabels: Record<StudentFeedbackPlanType, string> = {
  event_micro: "事件型微反馈",
  stage_trend: "阶段趋势反馈",
  course_end: "结课教学总结",
};

const closureLabels: Record<string, string> = {
  informational: "知情型",
  positive_recognition: "具体认可",
  teacher_resolved: "课堂已处理",
  home_cooperation: "家庭配合",
  continued_observation: "后续观察",
};

const moduleLabels: Record<string, string> = {
  lesson_scope: "本课内容",
  key_difficulty: "关键难点",
  class_handling: "班级处理",
  homework_review: "作业与复习",
  next_lesson_link: "下次课衔接",
  observed_moment: "具体表现",
  teacher_interpretation: "教师判断",
  teacher_intervention: "老师已经做了什么",
  intervention_outcome: "处理结果",
  parent_action: "家长最低动作",
  followup_observation: "后续观察",
  starting_point: "阶段起点",
  recent_trend: "近期趋势",
  stable_capability: "已稳定能力",
  unresolved_issue: "尚未稳定问题",
  teacher_support: "阶段内教师支持",
  next_stage_focus: "下一阶段重点",
  starting_state: "起点状态",
  evidence_backed_change: "有证据的变化",
  remaining_gap: "剩余断点",
  next_stage_learning_path: "下一阶段学习路径",
};

const moduleDescriptions: Record<string, string> = {
  lesson_scope: "本课讲了什么",
  key_difficulty: "最需要理解的难点",
  class_handling: "课堂如何处理",
  homework_review: "作业或复习建议",
  next_lesson_link: "与下次课如何衔接",
  observed_moment: "学生本次具体表现",
  teacher_interpretation: "教师对表现的判断",
  teacher_intervention: "老师已经采取的处理",
  intervention_outcome: "处理后的结果",
  parent_action: "家长可以做的最低动作",
  followup_observation: "后续需要观察什么",
  starting_point: "阶段开始时的状态",
  recent_trend: "近期变化趋势",
  stable_capability: "已经稳定的能力",
  unresolved_issue: "尚未稳定的问题",
  teacher_support: "阶段内已有的教师支持",
  next_stage_focus: "下一阶段重点",
  starting_state: "学习阶段的起点",
  evidence_backed_change: "有证据支持的变化",
  remaining_gap: "仍然存在的断点",
  next_stage_learning_path: "下一阶段学习路径",
};

type Draft = {
  type: StudentFeedbackPlanType;
  outputRequirement: string;
  closureType: FeedbackClosureType;
  moduleKeys: string[];
  length: "inherit" | "short" | "standard" | "detailed";
  tone: "inherit" | "gentle" | "professional";
};

function draftFromConfig(config: FeedbackPlanItemGenerationConfig): Draft {
  return {
    type: config.type as StudentFeedbackPlanType,
    outputRequirement: config.outputRequirement,
    closureType: config.generationPreferences.closureType,
    moduleKeys: [...config.generationPreferences.moduleKeys],
    length: config.generationPreferences.length ?? "inherit",
    tone: config.generationPreferences.tone ?? "inherit",
  };
}

function requiredModuleForClosure(closureType: FeedbackClosureType) {
  if (closureType === "continued_observation") return "followup_observation";
  if (closureType === "teacher_resolved") return "teacher_intervention";
  if (closureType === "home_cooperation") return "parent_action";
  return null;
}

export function FeedbackPlanGenerationConfigDialog({
  open,
  studentName,
  initialConfig,
  onClose,
  onSave,
  onReset,
  busy = false,
  error = "",
}: {
  open: boolean;
  studentName: string;
  initialConfig: FeedbackPlanItemGenerationConfig;
  onClose: () => void;
  onSave: (config: FeedbackPlanItemGenerationConfig) => void | Promise<void>;
  onReset?: () => void | Promise<void>;
  busy?: boolean;
  error?: string;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFromConfig(initialConfig));
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState("");
  const initialConfigSnapshot = JSON.stringify(initialConfig);

  useEffect(() => {
    if (!open) return;
    setDraft(draftFromConfig(JSON.parse(initialConfigSnapshot) as FeedbackPlanItemGenerationConfig));
    setLocalError("");
  }, [open, initialConfigSnapshot]);

  const moduleKeys = FEEDBACK_MODULES[draft.type];
  const allowedClosures = FEEDBACK_CLOSURES_BY_TYPE[draft.type];
  const requiredModule = requiredModuleForClosure(draft.closureType);
  const moduleSelectionLabel = useMemo(() => draft.moduleKeys.length ? draft.moduleKeys.map((key) => moduleLabels[key] || key).join("、") : "未预选，按当前类型自然组织", [draft.moduleKeys]);

  function changeType(nextType: StudentFeedbackPlanType) {
    const defaults = defaultFeedbackGenerationPreferences(nextType);
    setDraft((current) => ({ ...current, type: nextType, closureType: defaults.closureType, moduleKeys: [...defaults.moduleKeys], length: defaults.length ?? "inherit", tone: defaults.tone ?? "inherit" }));
  }

  function changeClosure(nextClosure: FeedbackClosureType) {
    const required = requiredModuleForClosure(nextClosure);
    setDraft((current) => ({
      ...current,
      closureType: nextClosure,
      // An empty selection means the full type catalog is available, so it
      // already satisfies a closure's semantic module dependency.
      moduleKeys: current.moduleKeys.length > 0 && required && !current.moduleKeys.includes(required)
        ? [...current.moduleKeys, required]
        : current.moduleKeys,
    }));
  }

  function toggleModule(key: string, enabled: boolean) {
    setDraft((current) => ({
      ...current,
      moduleKeys: enabled
        ? [...new Set([...current.moduleKeys, key])]
        : key === requiredModule && current.moduleKeys.length > 1
          ? current.moduleKeys
          : current.moduleKeys.filter((item) => item !== key),
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.outputRequirement.trim()) {
      setLocalError("请填写这位学生的特殊处理要求；可以直接沿用公共要求。");
      return;
    }
    const config: FeedbackPlanItemGenerationConfig = {
      version: 1,
      type: draft.type,
      outputRequirement: draft.outputRequirement.trim(),
      generationPreferences: {
        closureType: draft.closureType,
        moduleKeys: draft.moduleKeys,
        length: draft.length,
        tone: draft.tone,
      },
    };
    setSaving(true);
    setLocalError("");
    try {
      await onSave(config);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "保存独立计划失败");
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!onReset) return;
    setSaving(true);
    setLocalError("");
    try {
      await onReset();
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "恢复公共设置失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} title={`学生独立计划：${studentName}`} onClose={saving || busy ? () => undefined : onClose} size="wide">
      <form onSubmit={submit} className="feedback-plan-independent-dialog">
        <p className="feedback-plan-independent-dialog__notice">该学生仍属于本批次，但不遵循公共反馈模块和规则；课次、证据和导出归属仍来自本批次。</p>
        {(error || localError) && <StatusBanner tone="danger">{error || localError}</StatusBanner>}
        <div className="feedback-plan-form-grid">
          <FormField id="feedback-independent-type" label="这位学生的反馈类型" description="班级公共反馈不能作为单个学生的独立类型。" required>
            <Select id="feedback-independent-type" value={draft.type} onChange={(event) => changeType(event.target.value as StudentFeedbackPlanType)}>
              {STUDENT_FEEDBACK_PLAN_TYPES.map((type) => <option key={type} value={type}>{typeLabels[type]}</option>)}
            </Select>
          </FormField>
          <FormField id="feedback-independent-requirement" label="本生特殊处理要求" description="这段要求只会进入这位学生的生成，不会改变公共计划。" required>
            <Textarea id="feedback-independent-requirement" rows={4} value={draft.outputRequirement} onChange={(event) => setDraft((current) => ({ ...current, outputRequirement: event.target.value }))} />
          </FormField>
        </div>
        <fieldset className="feedback-plan-generation-preferences feedback-plan-independent-dialog__structure">
          <legend>这位学生的独立生成结构</legend>
          <div className="feedback-plan-form-grid">
            <FormField id="feedback-independent-closure" label="结尾类型" description="结尾仍需和正文内容语义一致。" required>
              <Select id="feedback-independent-closure" value={draft.closureType} onChange={(event) => changeClosure(event.target.value as FeedbackClosureType)}>
                {allowedClosures.map((closure) => <option key={closure} value={closure}>{closureLabels[closure] || closure}</option>)}
              </Select>
            </FormField>
            <div className="feedback-plan-independent-dialog__module-summary"><strong>当前模块范围</strong><span>{moduleSelectionLabel}</span><small>不选择模块时，模型可以在当前类型的完整目录内自然取舍；不会因数量阻断。</small></div>
            <FormField id="feedback-independent-length" label="详略" description="默认跟随该学生家庭偏好。" required>
              <Select id="feedback-independent-length" value={draft.length} onChange={(event) => setDraft((current) => ({ ...current, length: event.target.value as Draft["length"] }))}>
                <option value="inherit">随家庭偏好</option><option value="short">简洁</option><option value="standard">标准</option><option value="detailed">详细</option>
              </Select>
            </FormField>
            <FormField id="feedback-independent-tone" label="语气" description="默认跟随该学生家庭偏好。" required>
              <Select id="feedback-independent-tone" value={draft.tone} onChange={(event) => setDraft((current) => ({ ...current, tone: event.target.value as Draft["tone"] }))}>
                <option value="inherit">随家庭偏好</option><option value="gentle">温和</option><option value="professional">专业</option>
              </Select>
            </FormField>
          </div>
          <div className="feedback-plan-modules" aria-label={`${studentName}独立计划模块`}>
            <span className="feedback-plan-label">可选模块</span>
            {moduleKeys.map((key) => {
              const selected = draft.moduleKeys.includes(key);
              const required = key === requiredModule;
              const label = moduleLabels[key] || key;
              const description = moduleDescriptions[key] || "决定这条反馈关注的内容";
              const descriptionId = `feedback-independent-${key}-description`;
              return <label key={key} className={`feedback-plan-module ${selected ? "is-selected" : ""}`}>
                <input type="checkbox" checked={selected} disabled={required && draft.moduleKeys.length > 1} aria-label={`选择独立模块：${label}`} aria-describedby={descriptionId} onChange={(event) => toggleModule(key, event.target.checked)} />
                <span><strong>{label}</strong><small id={descriptionId}>{description}{required ? " · 当前结尾需要；不预选时由完整目录提供" : ""}</small></span>
              </label>;
            })}
          </div>
        </fieldset>
        <div className="feedback-plan-independent-dialog__actions">
          {onReset && <Button type="button" variant="ghost" onClick={() => void reset()} disabled={saving || busy}>恢复公共设置</Button>}
          <span />
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving || busy}>取消</Button>
          <Button type="submit" disabled={saving || busy}>{saving || busy ? "保存中…" : "保存独立计划"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function independentConfigFromCommon(common: FeedbackPlanItemGenerationConfig, current?: FeedbackPlanItemGenerationConfig | null): FeedbackPlanItemGenerationConfig {
  if (current) return current;
  const type = common.type === "class_update" ? "event_micro" : common.type;
  const defaults = defaultFeedbackGenerationPreferences(type);
  return {
    version: 1,
    type,
    outputRequirement: common.outputRequirement,
    generationPreferences: common.type === "class_update"
      ? { closureType: defaults.closureType, moduleKeys: [...defaults.moduleKeys] }
      : { closureType: common.generationPreferences.closureType, moduleKeys: [...common.generationPreferences.moduleKeys] },
  };
}
