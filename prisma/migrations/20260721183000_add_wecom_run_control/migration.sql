ALTER TABLE "WeComImportRun" ADD COLUMN "cancelRequestedAt" DATETIME;
ALTER TABLE "WeComImportRun" ADD COLUMN "cancelMode" TEXT;
ALTER TABLE "WeComImportOperation" ADD COLUMN "reviewReasonCodes" TEXT;
