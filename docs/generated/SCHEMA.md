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
    TEXT code UK
    TEXT name
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
    TEXT sourceKey UK
    DATETIME createdAt
  }
  DraftRecord {
    TEXT id PK
    TEXT rawText
    TEXT parsedResult
    TEXT reviewResult
    TEXT status
    TEXT sessionCode
    TEXT studentId
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
  Label {
    TEXT id PK
    TEXT name UK
  }
  Semester {
    TEXT id PK
    TEXT name
    TEXT startDate
    TEXT endDate
    DATETIME createdAt
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
    TEXT classId FK
    TEXT studentId UK
    TEXT gender
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
  WorkHistory {
    TEXT id PK
    TEXT module
    TEXT key
    TEXT title
    TEXT state
    DATETIME createdAt
  }
  Class o|--o{ ClassSession : "classId"
  Class ||--o{ Student : "classId"
  ClassSession o|--o{ SessionMetric : "sessionId"
  ClassSession ||--o{ Attendance : "sessionId"
  ClassSession ||--o{ Communication : "sessionId"
  ClassSession ||--o{ Event : "sessionId"
  Label ||--o{ StudentLabel : "labelId"
  Semester ||--o{ ClassSession : "semesterId"
  Student ||--o{ Attendance : "studentId"
  Student ||--o{ Communication : "studentId"
  Student ||--o{ Event : "studentId"
  Student ||--o{ SessionMetric : "studentId"
  Student ||--o{ StudentLabel : "studentId"
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
| `code` | `TEXT` | 是 | unique |
| `name` | `TEXT` | 否 |  |


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
| `sourceKey` | `TEXT` | 否 | unique |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |


### DraftRecord

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `rawText` | `TEXT` | 是 |  |
| `parsedResult` | `TEXT` | 是 |  |
| `reviewResult` | `TEXT` | 否 |  |
| `status` | `TEXT` | 是 | default: 'pending' |
| `sessionCode` | `TEXT` | 否 |  |
| `studentId` | `TEXT` | 否 |  |
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

### Label

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `name` | `TEXT` | 是 | unique |


### Semester

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `name` | `TEXT` | 是 |  |
| `startDate` | `TEXT` | 是 |  |
| `endDate` | `TEXT` | 是 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |


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
| `classId` | `TEXT` | 是 | FK |
| `studentId` | `TEXT` | 是 | unique |
| `gender` | `TEXT` | 是 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |
| `updatedAt` | `DATETIME` | 是 |  |


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

### WorkHistory

| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |
|---|---|---|---|
| `id` | `TEXT` | 是 | PK |
| `module` | `TEXT` | 是 |  |
| `key` | `TEXT` | 否 |  |
| `title` | `TEXT` | 是 |  |
| `state` | `TEXT` | 是 |  |
| `createdAt` | `DATETIME` | 是 | default: CURRENT_TIMESTAMP |

