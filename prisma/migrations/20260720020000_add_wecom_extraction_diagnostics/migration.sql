ALTER TABLE "WeComImportOperation" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WeComImportOperation" ADD COLUMN "failureCode" TEXT;
ALTER TABLE "WeComImportOperation" ADD COLUMN "modelName" TEXT;
ALTER TABLE "WeComImportOperation" ADD COLUMN "finishReason" TEXT;
ALTER TABLE "WeComImportOperation" ADD COLUMN "promptVersion" TEXT;
ALTER TABLE "WeComImportOperation" ADD COLUMN "promptTokens" INTEGER;
ALTER TABLE "WeComImportOperation" ADD COLUMN "reasoningTokens" INTEGER;
ALTER TABLE "WeComImportOperation" ADD COLUMN "completionTokens" INTEGER;
ALTER TABLE "WeComImportOperation" ADD COLUMN "responseCharacters" INTEGER;
