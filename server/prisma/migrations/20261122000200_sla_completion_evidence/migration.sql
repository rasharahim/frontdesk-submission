BEGIN;

ALTER TABLE "SlaClock"
  ADD COLUMN "completedDueAt" TIMESTAMPTZ(3),
  ADD COLUMN "completionOnTime" BOOLEAN,
  ADD CONSTRAINT "sla_completion_evidence" CHECK (
    ("completedDueAt" IS NULL AND "completionOnTime" IS NULL) OR
    (state = 'COMPLETED' AND "completedDueAt" IS NOT NULL AND "completionOnTime" IS NOT NULL)
  );

COMMIT;
