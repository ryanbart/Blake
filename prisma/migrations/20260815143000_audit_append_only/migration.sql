-- An audit log that can be rewritten is not evidence. Enforce append-only in
-- the database so it holds regardless of what the application layer does --
-- including a future bug, a migration script, or someone at a psql prompt.

CREATE OR REPLACE FUNCTION audit_event_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'AuditEvent is append-only: % on this table is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();
