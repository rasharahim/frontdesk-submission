BEGIN;

DO $$
BEGIN
  IF current_setting('TimeZone') <> 'UTC' THEN
    RAISE EXCEPTION 'The migration connection must use UTC';
  END IF;
END
$$;

CREATE TYPE "SlaDeadlineField" AS ENUM ('RUNNING_DUE_AT', 'COMPLETED_DUE_AT');

CREATE TABLE "SlaDeadlineCorrection" (
  "clockId" UUID PRIMARY KEY REFERENCES "SlaClock"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  field "SlaDeadlineField" NOT NULL,
  "originalDeadline" TIMESTAMPTZ(3) NOT NULL,
  "correctedDeadline" TIMESTAMPTZ(3) NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  "correctedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "correctedBy" TEXT NOT NULL DEFAULT CURRENT_USER,
  CHECK ("originalDeadline" <> "correctedDeadline")
);

CREATE TRIGGER "sla_corrections_no_update_or_delete" BEFORE UPDATE OR DELETE ON "SlaDeadlineCorrection"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER "sla_corrections_no_truncate" BEFORE TRUNCATE ON "SlaDeadlineCorrection"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();

REVOKE ALL ON "SlaDeadlineCorrection" FROM PUBLIC, frontdesk_runtime_access;
GRANT SELECT ON "SlaDeadlineCorrection" TO frontdesk_runtime_access;

COMMIT;
