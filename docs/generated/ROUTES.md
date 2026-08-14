# API 路由

> 自动生成，请勿手动修改。来源：`src/app/api/**/route.ts`。

| 路由 | 方法 |
|---|---|
| `/api/alerts` | `GET` |
| `/api/attendance` | `GET`, `PUT` |
| `/api/class-groups/[id]/lessons` | `POST` |
| `/api/class-groups/[id]` | `DELETE`, `PUT` |
| `/api/classes/[id]` | `DELETE`, `GET`, `PUT` |
| `/api/classes/[id]/step-roster` | `GET` |
| `/api/diarize/tasks/[id]/retry` | `POST` |
| `/api/diarize/tasks/[id]` | `DELETE`, `GET` |
| `/api/diarize/tasks` | `GET`, `POST` |
| `/api/export` | `POST` |
| `/api/feedback/assessment-pdf` | `POST` |
| `/api/feedback/assistant-roster` | `POST` |
| `/api/feedback/intake/runs/[id]` | `GET`, `POST` |
| `/api/feedback/intake/scan` | `POST` |
| `/api/feedback/intake/upload` | `POST` |
| `/api/feedback/script-library` | `GET`, `POST` |
| `/api/group-lessons/[id]/common-material` | `PUT` |
| `/api/group-lessons/[id]/confirm` | `POST` |
| `/api/group-lessons/[id]` | `PUT` |
| `/api/group-lessons/[id]/sessions` | `DELETE`, `POST` |
| `/api/input/parse` | `POST` |
| `/api/integrations/wecomcatch/v1/directory` | `GET` |
| `/api/quick-score` | `GET`, `POST` |
| `/api/report/daily` | `POST` |
| `/api/report/feedback-context` | `GET` |
| `/api/report/feedback-plan-batches/[id]` | `GET`, `POST` |
| `/api/report/feedback-plan-batches` | `GET`, `POST` |
| `/api/report/feedback-plans/[id]/attachments` | `DELETE`, `POST` |
| `/api/report/feedback-plans/[id]` | `DELETE`, `GET`, `PATCH`, `POST` |
| `/api/report/feedback-plans` | `GET`, `POST` |
| `/api/report/feedback-plans/task/[id]` | `PATCH` |
| `/api/report/teaching-summary` | `GET`, `POST` |
| `/api/review` | `GET`, `POST` |
| `/api/semesters/[id]/class-groups` | `GET`, `POST` |
| `/api/semesters/[id]/classes` | `GET`, `POST` |
| `/api/semesters/[id]` | `DELETE`, `GET`, `PUT` |
| `/api/semesters/[id]/session` | `DELETE`, `POST` |
| `/api/semesters` | `GET`, `POST` |
| `/api/sessions/[id]/common-material` | `PUT` |
| `/api/sessions/[id]/group-progress` | `GET`, `PUT` |
| `/api/sessions` | `GET` |
| `/api/settings/llm` | `DELETE`, `GET`, `PATCH`, `POST`, `PUT` |
| `/api/students/[id]/communication-preference/candidates/[candidateId]` | `PATCH` |
| `/api/students/[id]/communication-preference` | `GET`, `POST` |
| `/api/students/[id]/enrollment` | `PATCH` |
| `/api/students/[id]/history` | `GET` |
| `/api/students/[id]` | `DELETE`, `GET`, `PUT` |
| `/api/students/[id]/status` | `PATCH` |
| `/api/students/import` | `POST` |
| `/api/students` | `GET`, `POST` |
| `/api/system/archive` | `POST` |
| `/api/system/llm-cache` | `DELETE`, `GET` |
| `/api/system/local-tools` | `GET` |
| `/api/system/logs` | `GET` |
| `/api/teacher-observations/[id]` | `PATCH` |
| `/api/teacher-observations` | `GET` |
| `/api/teacher-tasks` | `GET` |
| `/api/teaching-memory` | `GET`, `PATCH`, `POST` |
| `/api/v1/system/health` | `GET` |
| `/api/wecom/handoff/[id]` | `GET`, `PATCH` |
| `/api/wecom/handoff/alignment-recovery` | `GET`, `POST` |
| `/api/wecom/handoff/batch-retry` | `POST` |
| `/api/wecom/handoff/receipt-repair` | `GET`, `POST` |
| `/api/wecom/handoff` | `GET`, `POST` |
| `/api/wecom/review-drafts/accept-confidence` | `POST` |
| `/api/wecom/review-drafts/bulk` | `POST` |
| `/api/wecom/review-drafts/preview` | `POST` |
| `/api/wecom/review-drafts/preview/status` | `GET`, `POST` |
| `/api/wecom/review-drafts` | `GET`, `PATCH`, `POST` |
