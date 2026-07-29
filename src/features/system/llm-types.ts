export interface LLMProfile {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  reasoningEnabled?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  createdAt: string;
  updatedAt: string;
}

export interface LLMSettingsResponse {
  activeProfileId: string | null;
  profiles: LLMProfile[];
  roleAssignments: LLMRoleAssignments;
  effectiveSettings: {
    apiBaseUrl: string;
    apiKey: string;
    model: string;
    maxTokens?: number;
    reasoningEnabled?: boolean;
    reasoningEffort?: "low" | "medium" | "high";
    updatedAt?: string;
  };
}

export interface LLMRoleAssignments {
  feedbackDraftProfileId: string | null;
  feedbackReviewProfileId: string | null;
  wecomExtractionProfileId: string | null;
}

export type LLMProfileForm = Partial<LLMProfile> & {
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  reasoningEnabled?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
};

export type LLMReasoningMode = "default" | "none" | "low" | "medium" | "high";

export const EMPTY_LLM_PROFILE: LLMProfileForm = {
  name: "LM Studio",
  apiBaseUrl: "http://localhost:1234/v1",
  apiKey: "lm-studio",
  model: "",
  maxTokens: 4096,
  reasoningEnabled: undefined,
  reasoningEffort: "low",
};
