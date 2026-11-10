-- AgentVault 7.6C.7: privilege isolation for the INACTIVE Model B PostgreSQL store.
-- Apply ONLY to a dedicated/private schema, after 7.6C.2 and 7.6C.5.
-- DBA prerequisite: create NOLOGIN roles av_model_b_reader and
-- av_model_b_coordinator. Grant membership only to the specific service login.
-- This intentionally never creates users, passwords, or production databases.
-- Requires the migration account to own the payment table (or be the DBA).
-- This does not provide cryptographic verification inside PostgreSQL:
-- the trusted coordinator STILL MUST use validateAuthorizedModelBPayment().
-- Never give the API/read-only process the coordinator credential.

BEGIN;

DO $av76c7_preflight$
DECLARE
  target_schema name := current_schema();
  table_oid oid;
  owner_oid oid;
  role_name text;
  privileged boolean;
BEGIN
  IF target_schema IS NULL OR target_schema IN ('public', 'pg_catalog', 'information_schema')
      OR target_schema LIKE 'pg_temp_%' THEN
    RAISE EXCEPTION 'REFUSE: Model B runtime privilege migration requires a private, dedicated schema';
  END IF;

  SELECT c.oid, c.relowner INTO table_oid, owner_oid
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = target_schema
      AND c.relname = 'agentvault_model_b_payment_requests'
      AND c.relkind = 'r';
  IF table_oid IS NULL THEN
    RAISE EXCEPTION 'REFUSE: payment table not found in intended schema';
  END IF;
  IF owner_oid <> current_user::regrole::oid THEN
    RAISE EXCEPTION 'REFUSE: run privilege migration as the payment table owner';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = table_oid AND attname = 'finalized_slot' AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = table_oid
      AND tgname = 'agentvault_model_b_mutation_guard'
      AND tgenabled IN ('O', 'A') AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'REFUSE: Model B finality schema/guard missing';
  END IF;

  FOREACH role_name IN ARRAY ARRAY['av_model_b_reader', 'av_model_b_coordinator'] LOOP
    SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolcanlogin
      INTO privileged
      FROM pg_catalog.pg_roles WHERE rolname = role_name;
    IF privileged IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'REFUSE: % must exist as a nonprivileged NOLOGIN role', role_name;
    END IF;
    IF pg_catalog.pg_has_role(role_name::regrole, owner_oid, 'MEMBER') THEN
      RAISE EXCEPTION 'REFUSE: % must not inherit or SET ROLE to the table owner', role_name;
    END IF;
  END LOOP;
  IF pg_catalog.pg_has_role('av_model_b_reader'::regrole,
                            'av_model_b_coordinator'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'REFUSE: read-only role must not inherit coordinator privileges';
  END IF;
  IF pg_catalog.has_schema_privilege('av_model_b_reader', target_schema, 'CREATE')
    OR pg_catalog.has_schema_privilege('av_model_b_coordinator', target_schema, 'CREATE') THEN
    RAISE EXCEPTION 'REFUSE: runtime roles must not create objects in private schema';
  END IF;
END
$av76c7_preflight$;

-- In a dedicated schema, revoke any accidental PUBLIC access to this table.
-- In particular, never grant blanket INSERT/UPDATE/DELETE/ALL to a web server.
REVOKE ALL PRIVILEGES ON TABLE agentvault_model_b_payment_requests FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE agentvault_model_b_payment_requests
  FROM av_model_b_reader, av_model_b_coordinator;

DO $av76c7_schema$
BEGIN
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO av_model_b_reader, av_model_b_coordinator',
                            current_schema());
END
$av76c7_schema$;

GRANT SELECT ON TABLE agentvault_model_b_payment_requests
  TO av_model_b_reader, av_model_b_coordinator;

-- The coordinator can make only the exact column writes used by the store.
-- SQL trigger and check constraints still reject invalid state transitions.
GRANT INSERT (request_id, genesis_hash, program_id, vault,
              workflow_digest, payment_digest)
  ON TABLE agentvault_model_b_payment_requests TO av_model_b_coordinator;
GRANT UPDATE (phase, signed_tx_bytes, signed_tx_sha256, tx_signature,
              last_valid_block_height, finalized_slot, finality_observed_at)
  ON TABLE agentvault_model_b_payment_requests TO av_model_b_coordinator;

-- Check EFFECTIVE privileges, including any inherited group roles or PUBLIC.
-- A grant inherited from an unrelated role invalidates this isolation.
DO $av76c7_audit$
DECLARE
  target_schema name := current_schema();
  table_oid oid := 'agentvault_model_b_payment_requests'::regclass::oid;
  forbidden_column text;
  role_name text;
BEGIN
  IF pg_catalog.has_table_privilege('av_model_b_reader', table_oid, 'INSERT')
     OR pg_catalog.has_table_privilege('av_model_b_reader', table_oid, 'UPDATE')
     OR pg_catalog.has_table_privilege('av_model_b_reader', table_oid, 'DELETE')
     OR pg_catalog.has_table_privilege('av_model_b_reader', table_oid, 'TRUNCATE')
     OR pg_catalog.has_table_privilege('av_model_b_reader', table_oid, 'TRIGGER')
     OR pg_catalog.has_table_privilege('av_model_b_reader', table_oid, 'REFERENCES') THEN
    RAISE EXCEPTION 'REFUSE: reader has unauthorized payment table permissions';
  END IF;
  FOR forbidden_column IN
    SELECT attname FROM pg_catalog.pg_attribute
      WHERE attrelid = table_oid AND attnum > 0 AND NOT attisdropped
  LOOP
    IF pg_catalog.has_column_privilege('av_model_b_reader', table_oid,
                                       forbidden_column, 'INSERT')
       OR pg_catalog.has_column_privilege('av_model_b_reader', table_oid,
                                          forbidden_column, 'UPDATE') THEN
      RAISE EXCEPTION 'REFUSE: reader inherited a column write grant';
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege('av_model_b_coordinator', table_oid, 'DELETE')
    OR pg_catalog.has_table_privilege('av_model_b_coordinator', table_oid, 'TRUNCATE')
    OR pg_catalog.has_table_privilege('av_model_b_coordinator', table_oid, 'TRIGGER')
    OR pg_catalog.has_table_privilege('av_model_b_coordinator', table_oid, 'REFERENCES') THEN
    RAISE EXCEPTION 'REFUSE: coordinator inherited an unsafe table privilege';
  END IF;
  FOR forbidden_column IN
    SELECT unnest(ARRAY['request_id', 'genesis_hash', 'program_id', 'vault',
                        'workflow_digest', 'payment_digest', 'created_at', 'changed_at'])
  LOOP
    IF pg_catalog.has_column_privilege('av_model_b_coordinator', table_oid,
                                       forbidden_column, 'UPDATE') THEN
      RAISE EXCEPTION 'REFUSE: coordinator can update protected column %', forbidden_column;
    END IF;
  END LOOP;
  IF pg_catalog.has_schema_privilege('av_model_b_reader', target_schema, 'CREATE')
    OR pg_catalog.has_schema_privilege('av_model_b_coordinator', target_schema, 'CREATE') THEN
    RAISE EXCEPTION 'REFUSE: runtime role acquired schema CREATE';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['av_model_b_reader', 'av_model_b_coordinator'] LOOP
    IF pg_catalog.has_database_privilege(role_name, current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'REFUSE: runtime role has database CREATE: %', role_name;
    END IF;
  END LOOP;
END
$av76c7_audit$;

COMMIT;
