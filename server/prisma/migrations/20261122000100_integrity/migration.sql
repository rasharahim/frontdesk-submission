BEGIN;

ALTER TABLE "User" ADD CONSTRAINT "user_normalized_email"
  CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254),
  ADD CONSTRAINT "user_display_name" CHECK (char_length(btrim("displayName")) BETWEEN 1 AND 100);
ALTER TABLE "Session" ADD CONSTRAINT "session_token_length" CHECK (octet_length("tokenHash") = 32),
  ADD CONSTRAINT "session_timestamps" CHECK ("expiresAt" > "createdAt" AND
    ("revokedAt" IS NULL OR "revokedAt" >= "createdAt"));
ALTER TABLE "HolidayCalendar" ADD CONSTRAINT "calendar_version" CHECK (version > 0),
  ADD CONSTRAINT "calendar_publication_time" CHECK ("publishedAt" >= "createdAt");
ALTER TABLE "Holiday" ADD CONSTRAINT "holiday_label" CHECK (char_length(btrim(label)) BETWEEN 1 AND 120);
ALTER TABLE "Ticket" ADD CONSTRAINT "ticket_reference_format" CHECK (reference ~ '^FD-[1-9][0-9]*$'),
  ADD CONSTRAINT "ticket_subject" CHECK (char_length(btrim(subject)) BETWEEN 1 AND 160),
  ADD CONSTRAINT "ticket_description" CHECK (char_length(btrim(description)) BETWEEN 1 AND 4000),
  ADD CONSTRAINT "ticket_source_not_self" CHECK ("sourceTicketId" <> id),
  ADD CONSTRAINT "ticket_status_metadata" CHECK (
    ((status = 'WAITING') = ("waitingSince" IS NOT NULL)) AND
    ((status = 'RESOLVED') = ("resolvedAt" IS NOT NULL)) AND
    ((status = 'CLOSED') = ("closedAt" IS NOT NULL)) AND
    ((status = 'CLOSED') = ("closeProcessedAt" IS NOT NULL)) AND
    (status = 'OPEN' OR "assigneeId" IS NOT NULL) AND
    ("closeDueAt" IS NULL OR (status = 'WAITING' AND "closeDueAt" >= "waitingSince")) AND
    ("closeProcessedAt" IS NULL OR "closeProcessedAt" >= "closedAt") AND
    ("waitingSince" IS NULL OR "waitingSince" >= "createdAt") AND
    ("resolvedAt" IS NULL OR "resolvedAt" >= "createdAt") AND
    ("closedAt" IS NULL OR "closedAt" >= "createdAt")
  );
ALTER TABLE "TicketMessage" ADD CONSTRAINT "message_body" CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000);
ALTER TABLE "SlaClock" ADD CONSTRAINT "sla_budgets" CHECK (
    "originalBudgetMs" >= 0 AND "budgetMs" >= 0 AND "elapsedMs" >= 0
  ),
  ADD CONSTRAINT "sla_cycle" CHECK (cycle > 0 AND (kind <> 'RESPONSE' OR cycle = 1)),
  ADD CONSTRAINT "sla_state_metadata" CHECK (
    ((state = 'RUNNING') = ("activeSince" IS NOT NULL)) AND
    ((state = 'RUNNING') = ("dueAt" IS NOT NULL)) AND
    ((state = 'PAUSED') = ("pausedAt" IS NOT NULL)) AND
    ((state IN ('COMPLETED', 'CANCELED')) = ("endedAt" IS NOT NULL)) AND
    ("endedAt" IS NULL OR "endedAt" >= "startedAt") AND
    (kind <> 'RESPONSE' OR state NOT IN ('PAUSED', 'CANCELED'))
  );
ALTER TABLE "AuditEvent" ADD CONSTRAINT "audit_actor" CHECK (
    ("actorKind" = 'USER') = ("actorId" IS NOT NULL)
  ),
  ADD CONSTRAINT "audit_details_object" CHECK (jsonb_typeof(details) = 'object');

CREATE INDEX "ticket_unassigned_open" ON "Ticket" ("createdAt", id)
  WHERE status = 'OPEN' AND "assigneeId" IS NULL;
CREATE INDEX "message_public_history" ON "TicketMessage" ("ticketId", "createdAt", id)
  WHERE kind <> 'INTERNAL';
CREATE UNIQUE INDEX "sla_one_active_per_kind" ON "SlaClock" ("ticketId", kind)
  WHERE state IN ('RUNNING', 'PAUSED');

CREATE FUNCTION reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Audit history is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER "audit_no_update_or_delete" BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER "audit_no_truncate" BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();

CREATE FUNCTION preserve_sla_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state IN ('COMPLETED', 'CANCELED') THEN
    RAISE EXCEPTION 'SLA history is immutable' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.id, NEW."ticketId", NEW.kind, NEW.cycle, NEW."startedAt", NEW."originalBudgetMs")
      IS DISTINCT FROM ROW(OLD.id, OLD."ticketId", OLD.kind, OLD.cycle, OLD."startedAt", OLD."originalBudgetMs")
      OR NEW."elapsedMs" < OLD."elapsedMs"
      OR (OLD."firstBreachedAt" IS NOT NULL AND NEW."firstBreachedAt" IS DISTINCT FROM OLD."firstBreachedAt") THEN
    RAISE EXCEPTION 'Cannot rewrite SLA identity, original budget, elapsed time or first breach' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "sla_preserve_history" BEFORE UPDATE OR DELETE ON "SlaClock"
  FOR EACH ROW EXECUTE FUNCTION preserve_sla_history();

CREATE FUNCTION preserve_published_calendar() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD."publishedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Published calendars are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "calendar_preserve_publication" BEFORE UPDATE OR DELETE ON "HolidayCalendar"
  FOR EACH ROW EXECUTE FUNCTION preserve_published_calendar();

CREATE FUNCTION edit_draft_holidays_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  calendar_id uuid;
  published_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."calendarId" IS DISTINCT FROM OLD."calendarId" THEN
    RAISE EXCEPTION 'Move a holiday by editing the two drafts separately' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN calendar_id := OLD."calendarId";
  ELSE calendar_id := NEW."calendarId"; END IF;
  SELECT "publishedAt" INTO published_at FROM public."HolidayCalendar"
    WHERE id = calendar_id FOR UPDATE;
  IF published_at IS NOT NULL THEN
    RAISE EXCEPTION 'Published calendar holidays are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "holiday_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "Holiday"
  FOR EACH ROW EXECUTE FUNCTION edit_draft_holidays_only();

CREATE FUNCTION require_published_ticket_calendar() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."calendarId" IS DISTINCT FROM OLD."calendarId" THEN
      RAISE EXCEPTION 'Ticket calendar cannot change' USING ERRCODE = '55000';
    END IF;
  ELSIF NOT EXISTS (SELECT FROM public."HolidayCalendar" WHERE id = NEW."calendarId" AND "publishedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Ticket requires a published holiday calendar' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ticket_calendar_snapshot" BEFORE INSERT OR UPDATE OF "calendarId" ON "Ticket"
  FOR EACH ROW EXECUTE FUNCTION require_published_ticket_calendar();

-- No default grants. Add only the privileges each new migration needs.
REVOKE ALL ON TABLE "AuditEvent" FROM PUBLIC, frontdesk_runtime_access;
GRANT SELECT ON "User", "HolidayCalendar", "Holiday" TO frontdesk_runtime_access;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Session" TO frontdesk_runtime_access;
GRANT SELECT, INSERT, UPDATE ON "Ticket", "SlaClock" TO frontdesk_runtime_access;
GRANT SELECT, INSERT ON "TicketMessage" TO frontdesk_runtime_access;
GRANT SELECT ON "AuditEvent" TO frontdesk_runtime_access;
GRANT INSERT ("ticketId", "actorId", "actorKind", action, "effectiveAt", "oldStatus", "newStatus", details)
  ON "AuditEvent" TO frontdesk_runtime_access;
GRANT USAGE ON SEQUENCE ticket_reference_seq, "AuditEvent_id_seq" TO frontdesk_runtime_access;

COMMIT;
