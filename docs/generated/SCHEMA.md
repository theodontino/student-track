# Schema 与 ER 图

> 自动生成，请勿手动修改。来源：Prisma 编译后的 SQLite Schema。

## ER 图

```mermaid
erDiagram
  Attendance {
    TEXT id PK
    TEXT sessionId FK
    TEXT studentId FK
    BOOLEAN present
    DATETIME createdAt
  }
  Class {
    TEXT id PK
    TEXT semesterId FK
    TEXT code
    TEXT name
  }
  ClassGroup {
    TEXT id PK
    TEXT semesterId FK
    TEXT name
    DATETIME createdAt
    DATETIME updatedAt
  }
  ClassGroupMembership {
    TEXT id PK
    TEXT groupId FK
    TEXT classId UK,FK
    DATETIME createdAt
  }
  ClassSession {
    TEXT id PK
    TEXT code UK
    TEXT semesterId FK
    INTEGER semesterNumber
    TEXT date
    TEXT classId FK
    DATETIME createdAt
  }
  Communication {
    TEXT id PK
    TEXT studentId FK
    TEXT sessionId FK
    TEXT target
    TEXT summary
    TEXT occurredAt
    TEXT sourceKey UK
    DATETIME createdAt
  }
  CommunicationPreference {
    TEXT id PK
    TEXT studentId UK,FK
    TEXT preferenceSnapshot
    TEXT sourceCandidateId UK,FK
    DATETIME confirmedAt
    DATETIME createdAt
    DATETIME updatedAt
  }
  CommunicationPreferenceCandidate {
    TEXT id PK
    TEXT studentId FK
    TEXT sourceType
    TEXT sourceId
    TEXT preferenceSnapshot
    TEXT evidenceSnapshot
    TEXT status
    DATETIME createdAt
    DATETIME reviewedAt
  }
  CommunicationRevision {
    TEXT id PK
    TEXT communicationId FK
    TEXT draftId FK
    TEXT handoffPackageId FK
    TEXT previousTarget
    TEXT nextTarget
    TEXT previousSummary
    TEXT nextSummary
    TEXT previousOccurredAt
    TEXT nextOccurredAt
    TEXT previousSessionId
    TEXT nextSessionId
    DATETIME confirmedAt
    DATETIME createdAt
  }
  DraftRecord {
    TEXT id PK
    TEXT rawText
    TEXT parsedResult
    TEXT reviewResult
    TEXT status
    TEXT kind
    TEXT sessionCode
    TEXT studentId
    TEXT supersedesDraftId FK
    TEXT communicationId FK
    TEXT handoffPackageId FK
    DATETIME createdAt
  }
  Event {
    TEXT id PK
    TEXT studentId FK
    TEXT sessionId FK
    TEXT type
    TEXT description
    TEXT rawText
    DATETIME createdAt
  }
  FeedbackAttachment {
    TEXT id PK
    TEXT planId FK
    TEXT planItemId FK
    TEXT displayName
    TEXT mimeType
    INTEGER sizeBytes
    TEXT sha256
    TEXT relativeLocator
    TEXT status
    DATETIME createdAt
    DATETIME deletedAt
  }
  FeedbackExportRun {
    TEXT id PK
    TEXT planId FK
    TEXT mode
    TEXT itemManifest
    TEXT manifestHash
    BOOLEAN isRepeat
    TEXT batchExportRunId FK
    DATETIME createdAt
  }
  FeedbackPlan {
    TEXT id PK
    TEXT type
    TEXT outputRequirement
    TEXT status
    TEXT semesterId FK
    TEXT classId FK
    TEXT sessionId FK
    TEXT rangeStartSessionId FK
    TEXT rangeEndSessionId FK
    TEXT inputFingerprint
    TEXT inputSnapshot
    TEXT generationMode
    DATETIME generationStartedAt
    DATETIME generationCompletedAt
    INTEGER generationElapsedMs
    DATETIME generationRunStartedAt
    INTEGER planRevision
    DATETIME createdAt
    DATETIME updatedAt
    DATETIME approvedAt
    DATETIME exportedAt
    DATETIME archivedAt
    TEXT batchId FK
    INTEGER batchOrder
  }
  FeedbackPlanBatch {
    TEXT id PK
    TEXT requestKey UK
    TEXT semesterId FK
    TEXT type
    TEXT outputRequirement
    TEXT generationMode
    TEXT status
    TEXT currentPlanId
    TEXT failedPlanId
    TEXT sharedLessonRevisionId FK
    INTEGER planRevision
    DATETIME createdAt
    DATETIME updatedAt
    DATETIME archivedAt
  }
  FeedbackPlanBatchExportRun {
    TEXT id PK
    TEXT batchId FK
    TEXT mode
    TEXT itemManifest
    TEXT manifestHash
    TEXT workbookSha256
    BOOLEAN isRepeat
    DATETIME createdAt
  }
  FeedbackPlanItem {
    TEXT id PK
    TEXT planId FK
    TEXT studentId FK
    TEXT status
    TEXT generationError
    TEXT generationConfigSnapshot
    TEXT evidenceSnapshot
    TEXT compositionSnapshot
    TEXT auditSnapshot
    TEXT finalText
    TEXT finalTextHash
    TEXT selectedGenerationId FK
    TEXT reviewMode
    DATETIME generationStartedAt
    DATETIME generationCompletedAt
    INTEGER generationDurationMs
    INTEGER itemRevision
    DATETIME createdAt
    DATETIME updatedAt
    DATETIME approvedAt
    DATETIME exportedAt
  }
  GenerationRecord {
    TEXT id PK
    TEXT taskType
    TEXT stage
    TEXT lifecycle
    TEXT semesterId
    TEXT classId
    TEXT sessionId
    TEXT studentId
    TEXT operationKey
    TEXT sourceRefs
    TEXT sourceFingerprint
    TEXT promptVersion
    TEXT modelName
    TEXT modelRole
    TEXT modelProfileId
    TEXT modelSettings
    TEXT inputRevision
    TEXT parentGenerationId FK
    TEXT feedbackPlanItemId FK
    TEXT variantKey UK
    TEXT inputSnapshot
    TEXT outputSnapshot
    TEXT finalText
    TEXT warmSnapshot
    DATETIME generatedAt
    DATETIME adoptedAt
    DATETIME compactedAt
    DATETIME purgedAt
    DATETIME staleAt
    DATETIME createdAt
    DATETIME updatedAt
  }
  GroupLesson {
    TEXT id PK
    TEXT groupId FK
    TEXT title
    INTEGER sequence
    TEXT materialSnapshot
    INTEGER revision
    DATETIME confirmedAt
    DATETIME createdAt
    DATETIME updatedAt
  }
  GroupLessonRevision {
    TEXT id PK
    TEXT groupLessonId FK
    INTEGER revision
    TEXT materialSnapshot
    DATETIME confirmedAt
  }
  GroupLessonSession {
    TEXT id PK
    TEXT groupLessonId FK
    TEXT sessionId UK,FK
    TEXT syncStatus
    TEXT differenceSummary
    BOOLEAN comparable
    DATETIME confirmedAt
    DATETIME updatedAt
  }
  Label {
    TEXT id PK
    TEXT name UK
  }
  MemoryCompactionRun {
    TEXT id PK
    TEXT classId
    TEXT semesterId
    TEXT fromSessionId
    TEXT toSessionId
    TEXT phase
    TEXT status
    TEXT sourceFingerprint
    INTEGER affectedCount
    TEXT resultJson
    TEXT rollbackPayload
    DATETIME undoUntil
    TEXT failureCode
    DATETIME createdAt
    DATETIME completedAt
    DATETIME updatedAt
  }
  Semester {
    TEXT id PK
    TEXT name
    TEXT startDate
    TEXT endDate
    DATETIME createdAt
    TEXT feedbackScriptLibraryName
    TEXT feedbackScriptLibraryJson
    DATETIME feedbackScriptLibraryUpdatedAt
  }
  SessionMetric {
    TEXT id PK
    TEXT studentId FK
    TEXT date
    INTEGER scoreA
    INTEGER scoreB
    INTEGER scoreC
    INTEGER scoreD
    TEXT operator
    TEXT sessionId FK
    DATETIME createdAt
  }
  SessionMetricHistory {
    TEXT id PK
    TEXT metricId
    TEXT studentId
    TEXT date
    INTEGER scoreA
    INTEGER scoreB
    INTEGER scoreC
    INTEGER scoreD
    TEXT operator
    TEXT sessionId
    DATETIME archivedAt
    TEXT changeType
  }
  Student {
    TEXT id PK
    TEXT name
    TEXT studentId UK
    TEXT gender
    DATETIME createdAt
    DATETIME updatedAt
  }
  StudentClassEnrollment {
    TEXT id PK
    TEXT studentId FK
    TEXT semesterId FK
    TEXT classId FK
    TEXT rosterStatus
    DATETIME statusEffectiveAt
    DATETIME createdAt
    DATETIME updatedAt
  }
  StudentLabel {
    TEXT studentId FK
    TEXT labelId FK
  }
  SystemLog {
    TEXT id PK
    TEXT action
    TEXT targetType
    TEXT targetId
    TEXT targetName
    TEXT detail
    DATETIME createdAt
  }
  TeacherObservation {
    TEXT id PK
    TEXT studentId FK
    TEXT kind
    TEXT topic
    TEXT title
    TEXT evidenceSummary
    TEXT status
    TEXT analysisVersion
    DATETIME firstDetectedAt
    DATETIME lastDetectedAt
    DATETIME statusChangedAt
    DATETIME createdAt
    DATETIME updatedAt
  }
  TeacherObservationSource {
    TEXT observationId PK,FK
    TEXT communicationId PK,FK
    TEXT relatedSessionId FK
    DATETIME createdAt
  }
  TeacherTask {
    TEXT id PK
    TEXT planId FK
    TEXT planItemId FK
    TEXT studentId FK
    TEXT classId FK
    TEXT action
    TEXT promiseExcerpt
    TEXT dueType
    TEXT dueDate
    TEXT dueSessionId FK
    INTEGER estimatedMinutes
    TEXT status
    TEXT sourceHash
    DATETIME createdAt
    DATETIME approvedAt
    DATETIME completedAt
    DATETIME updatedAt
  }
  TeachingMemory {
    TEXT id PK
    TEXT scopeType
    TEXT scopeId
    TEXT semesterKey
    TEXT semesterId
    TEXT memoryTier
    TEXT status
    TEXT content
    TEXT sourceRefs
    TEXT sourceFingerprint
    TEXT effectiveThrough
    DATETIME generatedAt
    DATETIME confirmedAt
    DATETIME createdAt
    DATETIME updatedAt
  }
  TeachingSummaryCache {
    TEXT id PK
    TEXT scopeType
    TEXT scopeKey
    BOOLEAN includeCommunications
    TEXT sourceFingerprint
    TEXT resultJson
    TEXT promptVersion
    TEXT modelName
    DATETIME generatedAt
    DATETIME createdAt
    DATETIME updatedAt
  }
  WeComHandoffPackage {
    TEXT id PK
    TEXT sourceId
    TEXT conversationId
    TEXT packageId
    TEXT packageSha256
    TEXT status
    TEXT outcome
    TEXT code
    INTEGER messageCount
    TEXT selectedStudentId FK
    TEXT rootPackageId
    TEXT parentPackageId
    INTEGER revisionNumber
    TEXT receiptId
    DATETIME producedAt
    DATETIME firstSeenAt
    DATETIME lastAttemptAt
    DATETIME processedAt
    DATETIME createdAt
    DATETIME updatedAt
  }
  WeComImportChange {
    TEXT id PK
    TEXT operationId FK
    TEXT entityType
    TEXT entityId
    TEXT studentId
    TEXT labelId
    DATETIME createdAt
  }
  WeComImportOperation {
    TEXT id PK
    TEXT runId FK
    TEXT batchKey
    TEXT conversationId
    TEXT conversationTitle
    TEXT status
    INTEGER messageCount
    TEXT candidateStudentIds
    INTEGER communicationCount
    INTEGER labelCount
    TEXT candidateJson
    DATETIME extractedAt
    INTEGER attemptCount
    TEXT failureCode
    TEXT reviewReasonCodes
    TEXT modelName
    TEXT finishReason
    TEXT promptVersion
    INTEGER promptTokens
    INTEGER reasoningTokens
    INTEGER completionTokens
    INTEGER responseCharacters
    DATETIME startedAt
    DATETIME completedAt
    DATETIME rolledBackAt
  }
  WeComImportRun {
    TEXT id PK
    TEXT status
    DATETIME windowStartedAt
    DATETIME windowEndedAt
    INTEGER conversationCount
    INTEGER messageCount
    INTEGER batchCount
    INTEGER communicationCount
    INTEGER labelCount
    DATETIME startedAt
    DATETIME completedAt
    DATETIME rolledBackAt
    DATETIME cancelRequestedAt
    TEXT cancelMode
  }
  WeComImportState {
    TEXT id PK
    DATETIME initializedAfter
    DATETIME lastSucceededUntil
    TEXT activeRunId
    DATETIME activeRunStartedAt
    DATETIME updatedAt
  }
  WeComMessageReceipt {
    TEXT messageId PK
    TEXT conversationId PK
    DATETIME sentAt
    TEXT contentHash
    TEXT status
    TEXT promptVersion
    TEXT operationId FK
    DATETIME processedAt
    TEXT lastError
    DATETIME createdAt
    DATETIME updatedAt
  }
  Class o|--o{ ClassSession : "classId"
  Class ||--o{ FeedbackPlan : "classId"
  Class ||--o{ StudentClassEnrollment : "classId"
  Class ||--o{ TeacherTask : "classId"
  Class ||--o| ClassGroupMembership : "classId"
  ClassGroup ||--o{ ClassGroupMembership : "groupId"
  ClassGroup ||--o{ GroupLesson : "groupId"
  ClassSession o|--o{ FeedbackPlan : "rangeEndSessionId"
  ClassSession o|--o{ FeedbackPlan : "rangeStartSessionId"
  ClassSession o|--o{ FeedbackPlan : "sessionId"
  ClassSession o|--o{ SessionMetric : "sessionId"
  ClassSession o|--o{ TeacherObservationSource : "relatedSessionId"
  ClassSession o|--o{ TeacherTask : "dueSessionId"
  ClassSession ||--o{ Attendance : "sessionId"
  ClassSession ||--o{ Communication : "sessionId"
  ClassSession ||--o{ Event : "sessionId"
  ClassSession ||--o| GroupLessonSession : "sessionId"
  Communication o|--o{ DraftRecord : "communicationId"
  Communication ||--o{ CommunicationRevision : "communicationId"
  Communication ||--o{ TeacherObservationSource : "communicationId"
  CommunicationPreferenceCandidate o|--o| CommunicationPreference : "sourceCandidateId"
  DraftRecord o|--o{ CommunicationRevision : "draftId"
  DraftRecord o|--o{ DraftRecord : "supersedesDraftId"
  FeedbackPlan ||--o{ FeedbackAttachment : "planId"
  FeedbackPlan ||--o{ FeedbackExportRun : "planId"
  FeedbackPlan ||--o{ FeedbackPlanItem : "planId"
  FeedbackPlan ||--o{ TeacherTask : "planId"
  FeedbackPlanBatch o|--o{ FeedbackPlan : "batchId"
  FeedbackPlanBatch ||--o{ FeedbackPlanBatchExportRun : "batchId"
  FeedbackPlanBatchExportRun o|--o{ FeedbackExportRun : "batchExportRunId"
  FeedbackPlanItem o|--o{ FeedbackAttachment : "planItemId"
  FeedbackPlanItem o|--o{ GenerationRecord : "feedbackPlanItemId"
  FeedbackPlanItem o|--o{ TeacherTask : "planItemId"
  GenerationRecord o|--o{ FeedbackPlanItem : "selectedGenerationId"
  GenerationRecord o|--o{ GenerationRecord : "parentGenerationId"
  GroupLesson ||--o{ GroupLessonRevision : "groupLessonId"
  GroupLesson ||--o{ GroupLessonSession : "groupLessonId"
  GroupLessonRevision o|--o{ FeedbackPlanBatch : "sharedLessonRevisionId"
  Label ||--o{ StudentLabel : "labelId"
  Semester ||--o{ Class : "semesterId"
  Semester ||--o{ ClassGroup : "semesterId"
  Semester ||--o{ ClassSession : "semesterId"
  Semester ||--o{ FeedbackPlan : "semesterId"
  Semester ||--o{ FeedbackPlanBatch : "semesterId"
  Semester ||--o{ StudentClassEnrollment : "semesterId"
  Student o|--o{ FeedbackPlanItem : "studentId"
  Student o|--o{ TeacherTask : "studentId"
  Student o|--o{ WeComHandoffPackage : "selectedStudentId"
  Student ||--o{ Attendance : "studentId"
  Student ||--o{ Communication : "studentId"
  Student ||--o{ CommunicationPreferenceCandidate : "studentId"
  Student ||--o{ Event : "studentId"
  Student ||--o{ SessionMetric : "studentId"
  Student ||--o{ StudentClassEnrollment : "studentId"
  Student ||--o{ StudentLabel : "studentId"
  Student ||--o{ TeacherObservation : "studentId"
  Student ||--o| CommunicationPreference : "studentId"
  TeacherObservation ||--o{ TeacherObservationSource : "observationId"
  WeComHandoffPackage o|--o{ CommunicationRevision : "handoffPackageId"
  WeComHandoffPackage o|--o{ DraftRecord : "handoffPackageId"
  WeComImportOperation o|--o{ WeComMessageReceipt : "operationId"
  WeComImportOperation ||--o{ WeComImportChange : "operationId"
  WeComImportRun ||--o{ WeComImportOperation : "runId"
```

## 模型字段

### Attendance

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `sessionId` | `TEXT` | 是 | FK |
| `studentId` | `TEXT` | 是 | FK |
| `present` | `BOOLEAN` | 是 | default: true |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |

复合唯一约束：`sessionId + studentId`。

### Class

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `semesterId` | `TEXT` | 是 | FK |
| `code` | `TEXT` | 是 |  |
| `name` | `TEXT` | 否 |  |

复合唯一约束：`semesterId + code`。

### ClassGroup

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `semesterId` | `TEXT` | 是 | FK |
| `name` | `TEXT` | 是 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |

复合唯一约束：`semesterId + name`。

### ClassGroupMembership

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `groupId` | `TEXT` | 是 | FK |
| `classId` | `TEXT` | 是 | unique, FK |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |

复合唯一约束：`groupId + classId`。

### ClassSession

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `code` | `TEXT` | 是 | unique |
| `semesterId` | `TEXT` | 是 | FK |
| `semesterNumber` | `INTEGER` | 是 |  |
| `date` | `TEXT` | 是 |  |
| `classId` | `TEXT` | 否 | FK |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |


### Communication

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `studentId` | `TEXT` | 是 | FK |
| `sessionId` | `TEXT` | 是 | FK |
| `target` | `TEXT` | 是 |  |
| `summary` | `TEXT` | 是 |  |
| `occurredAt` | `TEXT` | 是 | default: '' |
| `sourceKey` | `TEXT` | 否 | unique |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |

复合唯一约束：`studentId + sessionId + summary + occurredAt`。

### CommunicationPreference

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `studentId` | `TEXT` | 是 | unique, FK |
| `preferenceSnapshot` | `TEXT` | 是 | default: '{}' |
| `sourceCandidateId` | `TEXT` | 否 | unique, FK |
| `confirmedAt` | `DATETIME` | 否 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |


### CommunicationPreferenceCandidate

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `studentId` | `TEXT` | 是 | FK |
| `sourceType` | `TEXT` | 是 |  |
| `sourceId` | `TEXT` | 否 |  |
| `preferenceSnapshot` | `TEXT` | 是 | default: '{}' |
| `evidenceSnapshot` | `TEXT` | 是 | default: '{}' |
| `status` | `TEXT` | 是 | default: 'pending' |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `reviewedAt` | `DATETIME` | 否 |  |


### CommunicationRevision

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `communicationId` | `TEXT` | 是 | FK |
| `draftId` | `TEXT` | 否 | FK |
| `handoffPackageId` | `TEXT` | 否 | FK |
| `previousTarget` | `TEXT` | 是 |  |
| `nextTarget` | `TEXT` | 是 |  |
| `previousSummary` | `TEXT` | 是 |  |
| `nextSummary` | `TEXT` | 是 |  |
| `previousOccurredAt` | `TEXT` | 否 |  |
| `nextOccurredAt` | `TEXT` | 否 |  |
| `previousSessionId` | `TEXT` | 是 |  |
| `nextSessionId` | `TEXT` | 是 |  |
| `confirmedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |

复合唯一约束：`communicationId + draftId`。

### DraftRecord

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `rawText` | `TEXT` | 是 |  |
| `parsedResult` | `TEXT` | 是 |  |
| `reviewResult` | `TEXT` | 否 |  |
| `status` | `TEXT` | 是 | default: 'pending' |
| `kind` | `TEXT` | 是 | default: 'standard' |
| `sessionCode` | `TEXT` | 否 |  |
| `studentId` | `TEXT` | 否 |  |
| `supersedesDraftId` | `TEXT` | 否 | FK |
| `communicationId` | `TEXT` | 否 | FK |
| `handoffPackageId` | `TEXT` | 否 | FK |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |


### Event

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `studentId` | `TEXT` | 是 | FK |
| `sessionId` | `TEXT` | 是 | FK |
| `type` | `TEXT` | 是 |  |
| `description` | `TEXT` | 是 |  |
| `rawText` | `TEXT` | 是 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |

复合唯一约束：`studentId + sessionId + description`。

### FeedbackAttachment

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `planId` | `TEXT` | 是 | FK |
| `planItemId` | `TEXT` | 否 | FK |
| `displayName` | `TEXT` | 是 |  |
| `mimeType` | `TEXT` | 是 |  |
| `sizeBytes` | `INTEGER` | 是 |  |
| `sha256` | `TEXT` | 是 |  |
| `relativeLocator` | `TEXT` | 是 |  |
| `status` | `TEXT` | 是 | default: 'available' |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `deletedAt` | `DATETIME` | 否 |  |


### FeedbackExportRun

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `planId` | `TEXT` | 是 | FK |
| `mode` | `TEXT` | 是 |  |
| `itemManifest` | `TEXT` | 是 | default: '[]' |
| `manifestHash` | `TEXT` | 是 |  |
| `isRepeat` | `BOOLEAN` | 是 | default: false |
| `batchExportRunId` | `TEXT` | 否 | FK |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |


### FeedbackPlan

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `type` | `TEXT` | 是 |  |
| `outputRequirement` | `TEXT` | 是 |  |
| `status` | `TEXT` | 是 | default: 'draft' |
| `semesterId` | `TEXT` | 是 | FK |
| `classId` | `TEXT` | 是 | FK |
| `sessionId` | `TEXT` | 否 | FK |
| `rangeStartSessionId` | `TEXT` | 否 | FK |
| `rangeEndSessionId` | `TEXT` | 否 | FK |
| `inputFingerprint` | `TEXT` | 是 |  |
| `inputSnapshot` | `TEXT` | 是 | default: '{}' |
| `generationMode` | `TEXT` | 是 | default: 'standard' |
| `generationStartedAt` | `DATETIME` | 否 |  |
| `generationCompletedAt` | `DATETIME` | 否 |  |
| `generationElapsedMs` | `INTEGER` | 是 | default: 0 |
| `generationRunStartedAt` | `DATETIME` | 否 |  |
| `planRevision` | `INTEGER` | 是 | default: 1 |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |
| `approvedAt` | `DATETIME` | 否 |  |
| `exportedAt` | `DATETIME` | 否 |  |
| `archivedAt` | `DATETIME` | 否 |  |
| `batchId` | `TEXT` | 否 | FK |
| `batchOrder` | `INTEGER` | 否 |  |

复合唯一约束：`batchId + classId`、`batchId + batchOrder`。

### FeedbackPlanBatch

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `requestKey` | `TEXT` | 是 | unique |
| `semesterId` | `TEXT` | 是 | FK |
| `type` | `TEXT` | 是 |  |
| `outputRequirement` | `TEXT` | 是 |  |
| `generationMode` | `TEXT` | 是 | default: 'standard' |
| `status` | `TEXT` | 是 | default: 'ready' |
| `currentPlanId` | `TEXT` | 否 |  |
| `failedPlanId` | `TEXT` | 否 |  |
| `sharedLessonRevisionId` | `TEXT` | 否 | FK |
| `planRevision` | `INTEGER` | 是 | default: 1 |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |
| `archivedAt` | `DATETIME` | 否 |  |


### FeedbackPlanBatchExportRun

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `batchId` | `TEXT` | 是 | FK |
| `mode` | `TEXT` | 是 |  |
| `itemManifest` | `TEXT` | 是 | default: '[]' |
| `manifestHash` | `TEXT` | 是 |  |
| `workbookSha256` | `TEXT` | 是 |  |
| `isRepeat` | `BOOLEAN` | 是 | default: false |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |


### FeedbackPlanItem

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `planId` | `TEXT` | 是 | FK |
| `studentId` | `TEXT` | 否 | FK |
| `status` | `TEXT` | 是 | default: 'evidence_ready' |
| `generationError` | `TEXT` | 否 |  |
| `generationConfigSnapshot` | `TEXT` | 是 | default: '{}' |
| `evidenceSnapshot` | `TEXT` | 是 | default: '{}' |
| `compositionSnapshot` | `TEXT` | 是 | default: '{}' |
| `auditSnapshot` | `TEXT` | 是 | default: '{}' |
| `finalText` | `TEXT` | 否 |  |
| `finalTextHash` | `TEXT` | 否 |  |
| `selectedGenerationId` | `TEXT` | 否 | FK |
| `reviewMode` | `TEXT` | 是 | default: 'model' |
| `generationStartedAt` | `DATETIME` | 否 |  |
| `generationCompletedAt` | `DATETIME` | 否 |  |
| `generationDurationMs` | `INTEGER` | 否 |  |
| `itemRevision` | `INTEGER` | 是 | default: 1 |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |
| `approvedAt` | `DATETIME` | 否 |  |
| `exportedAt` | `DATETIME` | 否 |  |

复合唯一约束：`planId + studentId`。

### GenerationRecord

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `taskType` | `TEXT` | 是 |  |
| `stage` | `TEXT` | 是 |  |
| `lifecycle` | `TEXT` | 是 | default: 'hot' |
| `semesterId` | `TEXT` | 否 |  |
| `classId` | `TEXT` | 否 |  |
| `sessionId` | `TEXT` | 否 |  |
| `studentId` | `TEXT` | 否 |  |
| `operationKey` | `TEXT` | 否 |  |
| `sourceRefs` | `TEXT` | 是 | default: '[]' |
| `sourceFingerprint` | `TEXT` | 是 |  |
| `promptVersion` | `TEXT` | 是 |  |
| `modelName` | `TEXT` | 是 |  |
| `modelRole` | `TEXT` | 否 |  |
| `modelProfileId` | `TEXT` | 否 |  |
| `modelSettings` | `TEXT` | 是 | default: '{}' |
| `inputRevision` | `TEXT` | 否 |  |
| `parentGenerationId` | `TEXT` | 否 | FK |
| `feedbackPlanItemId` | `TEXT` | 否 | FK |
| `variantKey` | `TEXT` | 否 | unique |
| `inputSnapshot` | `TEXT` | 否 |  |
| `outputSnapshot` | `TEXT` | 否 |  |
| `finalText` | `TEXT` | 否 |  |
| `warmSnapshot` | `TEXT` | 否 |  |
| `generatedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `adoptedAt` | `DATETIME` | 否 |  |
| `compactedAt` | `DATETIME` | 否 |  |
| `purgedAt` | `DATETIME` | 否 |  |
| `staleAt` | `DATETIME` | 否 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |


### GroupLesson

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `groupId` | `TEXT` | 是 | FK |
| `title` | `TEXT` | 是 |  |
| `sequence` | `INTEGER` | 是 |  |
| `materialSnapshot` | `TEXT` | 是 | default: '{}' |
| `revision` | `INTEGER` | 是 | default: 0 |
| `confirmedAt` | `DATETIME` | 否 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |

复合唯一约束：`groupId + sequence`。

### GroupLessonRevision

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `groupLessonId` | `TEXT` | 是 | FK |
| `revision` | `INTEGER` | 是 |  |
| `materialSnapshot` | `TEXT` | 是 |  |
| `confirmedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |

复合唯一约束：`groupLessonId + revision`。

### GroupLessonSession

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `groupLessonId` | `TEXT` | 是 | FK |
| `sessionId` | `TEXT` | 是 | unique, FK |
| `syncStatus` | `TEXT` | 是 |  |
| `differenceSummary` | `TEXT` | 否 |  |
| `comparable` | `BOOLEAN` | 是 | default: true |
| `confirmedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |

复合唯一约束：`groupLessonId + sessionId`。

### Label

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `name` | `TEXT` | 是 | unique |


### MemoryCompactionRun

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `classId` | `TEXT` | 是 |  |
| `semesterId` | `TEXT` | 否 |  |
| `fromSessionId` | `TEXT` | 否 |  |
| `toSessionId` | `TEXT` | 否 |  |
| `phase` | `TEXT` | 是 |  |
| `status` | `TEXT` | 是 | default: 'pending' |
| `sourceFingerprint` | `TEXT` | 是 |  |
| `affectedCount` | `INTEGER` | 是 | default: 0 |
| `resultJson` | `TEXT` | 否 |  |
| `rollbackPayload` | `TEXT` | 否 |  |
| `undoUntil` | `DATETIME` | 否 |  |
| `failureCode` | `TEXT` | 否 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `completedAt` | `DATETIME` | 否 |  |
| `updatedAt` | `DATETIME` | 是 |  |

复合唯一约束：`classId + phase + sourceFingerprint`。

### Semester

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `name` | `TEXT` | 是 |  |
| `startDate` | `TEXT` | 是 |  |
| `endDate` | `TEXT` | 是 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `feedbackScriptLibraryName` | `TEXT` | 否 |  |
| `feedbackScriptLibraryJson` | `TEXT` | 否 |  |
| `feedbackScriptLibraryUpdatedAt` | `DATETIME` | 否 |  |


### SessionMetric

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `studentId` | `TEXT` | 是 | FK |
| `date` | `TEXT` | 是 |  |
| `scoreA` | `INTEGER` | 是 |  |
| `scoreB` | `INTEGER` | 是 |  |
| `scoreC` | `INTEGER` | 是 |  |
| `scoreD` | `INTEGER` | 是 | default: 3 |
| `operator` | `TEXT` | 是 |  |
| `sessionId` | `TEXT` | 否 | FK |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |

复合唯一约束：`studentId + sessionId`。

### SessionMetricHistory

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `metricId` | `TEXT` | 是 |  |
| `studentId` | `TEXT` | 是 |  |
| `date` | `TEXT` | 是 |  |
| `scoreA` | `INTEGER` | 是 |  |
| `scoreB` | `INTEGER` | 是 |  |
| `scoreC` | `INTEGER` | 是 |  |
| `scoreD` | `INTEGER` | 是 |  |
| `operator` | `TEXT` | 是 |  |
| `sessionId` | `TEXT` | 否 |  |
| `archivedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `changeType` | `TEXT` | 是 |  |


### Student

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `name` | `TEXT` | 是 |  |
| `studentId` | `TEXT` | 是 | unique |
| `gender` | `TEXT` | 是 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |


### StudentClassEnrollment

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `studentId` | `TEXT` | 是 | FK |
| `semesterId` | `TEXT` | 是 | FK |
| `classId` | `TEXT` | 是 | FK |
| `rosterStatus` | `TEXT` | 是 | default: 'ACTIVE' |
| `statusEffectiveAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |

复合唯一约束：`studentId + semesterId`。

### StudentLabel

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `studentId` | `TEXT` | 是 | FK |
| `labelId` | `TEXT` | 是 | FK |

复合唯一约束：`studentId + labelId`。

### SystemLog

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `action` | `TEXT` | 是 |  |
| `targetType` | `TEXT` | 是 |  |
| `targetId` | `TEXT` | 否 |  |
| `targetName` | `TEXT` | 否 |  |
| `detail` | `TEXT` | 是 | default: '{}' |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |


### TeacherObservation

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `studentId` | `TEXT` | 是 | FK |
| `kind` | `TEXT` | 是 |  |
| `topic` | `TEXT` | 是 |  |
| `title` | `TEXT` | 是 |  |
| `evidenceSummary` | `TEXT` | 是 |  |
| `status` | `TEXT` | 是 | default: 'new' |
| `analysisVersion` | `TEXT` | 是 |  |
| `firstDetectedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `lastDetectedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `statusChangedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |

复合唯一约束：`studentId + kind + topic`。

### TeacherObservationSource

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `observationId` | `TEXT` | 是 | PK, FK |
| `communicationId` | `TEXT` | 是 | PK, FK |
| `relatedSessionId` | `TEXT` | 否 | FK |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |

复合唯一约束：`observationId + communicationId`。

### TeacherTask

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `planId` | `TEXT` | 是 | FK |
| `planItemId` | `TEXT` | 否 | FK |
| `studentId` | `TEXT` | 否 | FK |
| `classId` | `TEXT` | 是 | FK |
| `action` | `TEXT` | 是 |  |
| `promiseExcerpt` | `TEXT` | 否 |  |
| `dueType` | `TEXT` | 是 |  |
| `dueDate` | `TEXT` | 否 |  |
| `dueSessionId` | `TEXT` | 否 | FK |
| `estimatedMinutes` | `INTEGER` | 否 |  |
| `status` | `TEXT` | 是 | default: 'pending' |
| `sourceHash` | `TEXT` | 否 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `approvedAt` | `DATETIME` | 否 |  |
| `completedAt` | `DATETIME` | 否 |  |
| `updatedAt` | `DATETIME` | 是 |  |


### TeachingMemory

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `scopeType` | `TEXT` | 是 |  |
| `scopeId` | `TEXT` | 是 |  |
| `semesterKey` | `TEXT` | 是 |  |
| `semesterId` | `TEXT` | 否 |  |
| `memoryTier` | `TEXT` | 是 |  |
| `status` | `TEXT` | 是 | default: 'confirmed' |
| `content` | `TEXT` | 是 |  |
| `sourceRefs` | `TEXT` | 是 | default: '[]' |
| `sourceFingerprint` | `TEXT` | 是 |  |
| `effectiveThrough` | `TEXT` | 否 |  |
| `generatedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `confirmedAt` | `DATETIME` | 否 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |

复合唯一约束：`scopeType + scopeId + semesterKey + memoryTier`。

### TeachingSummaryCache

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `scopeType` | `TEXT` | 是 |  |
| `scopeKey` | `TEXT` | 是 |  |
| `includeCommunications` | `BOOLEAN` | 是 |  |
| `sourceFingerprint` | `TEXT` | 是 |  |
| `resultJson` | `TEXT` | 是 |  |
| `promptVersion` | `TEXT` | 是 |  |
| `modelName` | `TEXT` | 是 |  |
| `generatedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |

复合唯一约束：`scopeType + scopeKey + includeCommunications`。

### WeComHandoffPackage

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `sourceId` | `TEXT` | 是 |  |
| `conversationId` | `TEXT` | 否 |  |
| `packageId` | `TEXT` | 是 |  |
| `packageSha256` | `TEXT` | 是 |  |
| `status` | `TEXT` | 是 |  |
| `outcome` | `TEXT` | 否 |  |
| `code` | `TEXT` | 否 |  |
| `messageCount` | `INTEGER` | 是 |  |
| `selectedStudentId` | `TEXT` | 否 | FK |
| `rootPackageId` | `TEXT` | 否 |  |
| `parentPackageId` | `TEXT` | 否 |  |
| `revisionNumber` | `INTEGER` | 是 | default: 1 |
| `receiptId` | `TEXT` | 否 |  |
| `producedAt` | `DATETIME` | 是 |  |
| `firstSeenAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `lastAttemptAt` | `DATETIME` | 否 |  |
| `processedAt` | `DATETIME` | 否 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |

复合唯一约束：`sourceId + packageId + packageSha256`。

### WeComImportChange

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `operationId` | `TEXT` | 是 | FK |
| `entityType` | `TEXT` | 是 |  |
| `entityId` | `TEXT` | 是 |  |
| `studentId` | `TEXT` | 否 |  |
| `labelId` | `TEXT` | 否 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |

复合唯一约束：`operationId + entityType + entityId`。

### WeComImportOperation

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `runId` | `TEXT` | 是 | FK |
| `batchKey` | `TEXT` | 是 |  |
| `conversationId` | `TEXT` | 是 |  |
| `conversationTitle` | `TEXT` | 是 |  |
| `status` | `TEXT` | 是 |  |
| `messageCount` | `INTEGER` | 是 |  |
| `candidateStudentIds` | `TEXT` | 是 | default: '[]' |
| `communicationCount` | `INTEGER` | 是 | default: 0 |
| `labelCount` | `INTEGER` | 是 | default: 0 |
| `candidateJson` | `TEXT` | 否 |  |
| `extractedAt` | `DATETIME` | 否 |  |
| `attemptCount` | `INTEGER` | 是 | default: 0 |
| `failureCode` | `TEXT` | 否 |  |
| `reviewReasonCodes` | `TEXT` | 否 |  |
| `modelName` | `TEXT` | 否 |  |
| `finishReason` | `TEXT` | 否 |  |
| `promptVersion` | `TEXT` | 否 |  |
| `promptTokens` | `INTEGER` | 否 |  |
| `reasoningTokens` | `INTEGER` | 否 |  |
| `completionTokens` | `INTEGER` | 否 |  |
| `responseCharacters` | `INTEGER` | 否 |  |
| `startedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `completedAt` | `DATETIME` | 否 |  |
| `rolledBackAt` | `DATETIME` | 否 |  |

复合唯一约束：`runId + batchKey`。

### WeComImportRun

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `status` | `TEXT` | 是 |  |
| `windowStartedAt` | `DATETIME` | 是 |  |
| `windowEndedAt` | `DATETIME` | 是 |  |
| `conversationCount` | `INTEGER` | 是 | default: 0 |
| `messageCount` | `INTEGER` | 是 | default: 0 |
| `batchCount` | `INTEGER` | 是 | default: 0 |
| `communicationCount` | `INTEGER` | 是 | default: 0 |
| `labelCount` | `INTEGER` | 是 | default: 0 |
| `startedAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `completedAt` | `DATETIME` | 否 |  |
| `rolledBackAt` | `DATETIME` | 否 |  |
| `cancelRequestedAt` | `DATETIME` | 否 |  |
| `cancelMode` | `TEXT` | 否 |  |


### WeComImportState

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `initializedAfter` | `DATETIME` | 是 |  |
| `lastSucceededUntil` | `DATETIME` | 否 |  |
| `activeRunId` | `TEXT` | 否 |  |
| `activeRunStartedAt` | `DATETIME` | 否 |  |
| `updatedAt` | `DATETIME` | 是 |  |


### WeComMessageReceipt

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `messageId` | `TEXT` | 是 | PK |
| `conversationId` | `TEXT` | 是 | PK |
| `sentAt` | `DATETIME` | 否 |  |
| `contentHash` | `TEXT` | 是 |  |
| `status` | `TEXT` | 是 |  |
| `promptVersion` | `TEXT` | 是 |  |
| `operationId` | `TEXT` | 否 | FK |
| `processedAt` | `DATETIME` | 否 |  |
| `lastError` | `TEXT` | 否 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |

复合唯一约束：`conversationId + messageId`。
