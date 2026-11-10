-- AgentVault 7.6C.8: eliminate direct runtime DML on INACTIVE Model B payments.
-- Run after 7.6C.2, 7.6C.5, and 7.6C.7 in a dedicated private schema.
-- One-time migration; review on a disposable database before production.
-- Requires third DBA-provisioned NOLOGIN role: av_model_b_finalizer.
-- This is an SQL permission boundary, NOT Solana signature/RPC validation.
-- Each separately deployed service must run under its own non-owner login.
BEGIN;

DO $av76c8$
DECLARE
  target_schema name := current_schema();
  table_owner oid;
  role_name text;
  privileged boolean;
  col_name text;
  func_oid oid;
BEGIN
  IF target_schema IS NULL OR target_schema IN ('public', 'pg_catalog', 'information_schema')
     OR target_schema LIKE 'pg_temp_%' THEN
    RAISE EXCEPTION 'REFUSE: guarded writes require a dedicated private schema';
  END IF;
  SELECT c.relowner INTO table_owner
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = target_schema
     AND c.relname = 'agentvault_model_b_payment_requests' AND c.relkind = 'r';
  IF table_owner IS NULL OR table_owner <> current_user::regrole::oid THEN
    RAISE EXCEPTION 'REFUSE: guarded migration requires payment table owner';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = pg_catalog.format('%I.agentvault_model_b_payment_requests', target_schema)::regclass
       AND tgname = 'agentvault_model_b_mutation_guard' AND tgenabled IN ('O', 'A')
       AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = pg_catalog.format('%I.agentvault_model_b_payment_requests', target_schema)::regclass
       AND attname = 'finalized_slot' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'REFUSE: missing finality migration/guard';
  END IF;
  FOREACH role_name IN ARRAY ARRAY[
    'av_model_b_reader', 'av_model_b_coordinator', 'av_model_b_finalizer'
  ] LOOP
    SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR
           rolbypassrls OR rolcanlogin INTO privileged
      FROM pg_catalog.pg_roles WHERE rolname = role_name;
    IF privileged IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'REFUSE: % must be a nonprivileged NOLOGIN role', role_name;
    END IF;
    IF pg_catalog.pg_has_role(role_name::regrole, table_owner, 'MEMBER') THEN
      RAISE EXCEPTION 'REFUSE: runtime role may assume payment table owner: %', role_name;
    END IF;
    IF pg_catalog.has_schema_privilege(role_name, target_schema, 'CREATE') OR
       pg_catalog.has_database_privilege(role_name, current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'REFUSE: runtime role can create schema/database objects: %', role_name;
    END IF;
  END LOOP;
  IF pg_catalog.pg_has_role('av_model_b_reader'::regrole,
                            'av_model_b_coordinator'::regrole, 'MEMBER')
      OR pg_catalog.pg_has_role('av_model_b_reader'::regrole,
                                'av_model_b_finalizer'::regrole, 'MEMBER')
      OR pg_catalog.pg_has_role('av_model_b_coordinator'::regrole,
                                'av_model_b_finalizer'::regrole, 'MEMBER')
      OR pg_catalog.pg_has_role('av_model_b_finalizer'::regrole,
                                'av_model_b_coordinator'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'REFUSE: runtime identities must not inherit each other';
  END IF;

  -- Revoke the 7.6C.7 column grants, not just table-level permissions.
  REVOKE INSERT (request_id, genesis_hash, program_id, vault,
                 workflow_digest, payment_digest)
    ON agentvault_model_b_payment_requests FROM av_model_b_coordinator;
  REVOKE UPDATE (phase, signed_tx_bytes, signed_tx_sha256, tx_signature,
                 last_valid_block_height, finalized_slot, finality_observed_at)
    ON agentvault_model_b_payment_requests FROM av_model_b_coordinator;
  REVOKE ALL ON TABLE agentvault_model_b_payment_requests FROM PUBLIC;
  REVOKE ALL ON TABLE agentvault_model_b_payment_requests
    FROM av_model_b_reader, av_model_b_coordinator, av_model_b_finalizer;
  GRANT SELECT ON TABLE agentvault_model_b_payment_requests
    TO av_model_b_reader, av_model_b_coordinator, av_model_b_finalizer;
  EXECUTE pg_catalog.format(
    'GRANT USAGE ON SCHEMA %I TO av_model_b_finalizer', target_schema);

  -- SQL SECURITY DEFINER functions execute as the schema/table owner.
  -- Fully qualified table paths and fixed pg_catalog search_path prevent
  -- caller-controlled object/function shadowing. CREATE, never OR REPLACE.
  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION %1$I.agentvault_model_b_claim_guarded(
      text, text, text, text, text, text)
    RETURNS SETOF %1$I.agentvault_model_b_payment_requests
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $body$
      INSERT INTO %1$I.agentvault_model_b_payment_requests
        (request_id, genesis_hash, program_id, vault, workflow_digest, payment_digest)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (request_id) DO NOTHING RETURNING *;
    $body$;
  $ddl$, target_schema);

  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION %1$I.agentvault_model_b_prepare_guarded(
      text, bytea, text, text, bigint, text, text, text, text, text)
    RETURNS SETOF %1$I.agentvault_model_b_payment_requests
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $body$
      UPDATE %1$I.agentvault_model_b_payment_requests
      SET phase = 'PREPARED', signed_tx_bytes = $2, signed_tx_sha256 = $3,
          tx_signature = $4, last_valid_block_height = $5
      WHERE request_id = $1 AND phase = 'CLAIMED'
        AND genesis_hash = $6 AND program_id = $7 AND vault = $8
        AND workflow_digest = $9 AND payment_digest = $10
      RETURNING *;
    $body$;
  $ddl$, target_schema);

  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION %1$I.agentvault_model_b_reserve_guarded(text)
    RETURNS SETOF %1$I.agentvault_model_b_payment_requests
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $body$
      UPDATE %1$I.agentvault_model_b_payment_requests
      SET phase = 'SUBMISSION_RESERVED'
      WHERE request_id = $1 AND phase = 'PREPARED'
      RETURNING *;
    $body$;
  $ddl$, target_schema);

  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION %1$I.agentvault_model_b_reconcile_guarded(
      text, text, text, text, text, text, text, text, bigint, bytea, text, bigint)
    RETURNS SETOF %1$I.agentvault_model_b_payment_requests
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $body$
      UPDATE %1$I.agentvault_model_b_payment_requests
      SET phase = $11, finalized_slot = $12,
          finality_observed_at = CASE WHEN $12 IS NULL
            THEN NULL ELSE pg_catalog.clock_timestamp() END
      WHERE request_id = $1 AND genesis_hash = $2 AND program_id = $3
        AND vault = $4 AND workflow_digest = $5 AND payment_digest = $6
        AND signed_tx_sha256 = $7 AND tx_signature = $8
        AND last_valid_block_height = $9 AND signed_tx_bytes = $10
        AND (
          (phase = 'SUBMISSION_RESERVED' AND $11 IN
            ('UNRESOLVED', 'CONFIRMED', 'FAILED'))
          OR (phase = 'UNRESOLVED' AND $11 IN ('CONFIRMED', 'FAILED'))
        )
        AND (
          ($11 IN ('CONFIRMED', 'FAILED') AND $12 IS NOT NULL AND $12 >= 0)
          OR ($11 = 'UNRESOLVED' AND $12 IS NULL)
        )
      RETURNING *;
    $body$;
  $ddl$, target_schema);

  -- New PostgreSQL functions grant EXECUTE to PUBLIC by default.
  -- Restrict all four inside this transaction (no public exposure at commit).
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %1$I.agentvault_model_b_claim_guarded(text,text,text,text,text,text) FROM PUBLIC', target_schema);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %1$I.agentvault_model_b_prepare_guarded(text,bytea,text,text,bigint,text,text,text,text,text) FROM PUBLIC', target_schema);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %1$I.agentvault_model_b_reserve_guarded(text) FROM PUBLIC', target_schema);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %1$I.agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint) FROM PUBLIC', target_schema);
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION %1$I.agentvault_model_b_claim_guarded(text,text,text,text,text,text) TO av_model_b_coordinator', target_schema);
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION %1$I.agentvault_model_b_prepare_guarded(text,bytea,text,text,bigint,text,text,text,text,text) TO av_model_b_coordinator', target_schema);
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION %1$I.agentvault_model_b_reserve_guarded(text) TO av_model_b_coordinator', target_schema);
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION %1$I.agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint) TO av_model_b_finalizer', target_schema);

  -- Fail transaction if an effective permission bypass remains (including
  -- inherited group grants). Column privileges are audited individually.
  FOREACH role_name IN ARRAY ARRAY[
    'av_model_b_reader', 'av_model_b_coordinator', 'av_model_b_finalizer'
  ] LOOP
    IF NOT pg_catalog.has_table_privilege(role_name,
         pg_catalog.format('%I.agentvault_model_b_payment_requests',target_schema), 'SELECT') THEN
      RAISE EXCEPTION 'REFUSE: missing payment read permission for %', role_name;
    END IF;
    IF pg_catalog.has_table_privilege(role_name,
        pg_catalog.format('%I.agentvault_model_b_payment_requests',target_schema), 'INSERT')
        OR pg_catalog.has_table_privilege(role_name,
        pg_catalog.format('%I.agentvault_model_b_payment_requests',target_schema), 'UPDATE')
        OR pg_catalog.has_table_privilege(role_name,
        pg_catalog.format('%I.agentvault_model_b_payment_requests',target_schema), 'DELETE')
        OR pg_catalog.has_table_privilege(role_name,
        pg_catalog.format('%I.agentvault_model_b_payment_requests',target_schema), 'TRUNCATE')
        OR pg_catalog.has_table_privilege(role_name,
        pg_catalog.format('%I.agentvault_model_b_payment_requests',target_schema), 'TRIGGER') THEN
      RAISE EXCEPTION 'REFUSE: direct table mutation privilege remains for %', role_name;
    END IF;
    FOR col_name IN
      SELECT attname FROM pg_catalog.pg_attribute
      WHERE attrelid = pg_catalog.format('%I.agentvault_model_b_payment_requests', target_schema)::regclass
        AND attnum > 0 AND NOT attisdropped
    LOOP
      IF pg_catalog.has_column_privilege(role_name,
           pg_catalog.format('%I.agentvault_model_b_payment_requests', target_schema),
           col_name, 'INSERT') OR
         pg_catalog.has_column_privilege(role_name,
           pg_catalog.format('%I.agentvault_model_b_payment_requests', target_schema),
           col_name, 'UPDATE') THEN
        RAISE EXCEPTION 'REFUSE: direct column mutation privilege remains: %, %',
          role_name, col_name;
      END IF;
    END LOOP;
  END LOOP;
  FOR role_name IN SELECT unnest(ARRAY['av_model_b_reader', 'av_model_b_coordinator']) LOOP
    IF pg_catalog.has_function_privilege(role_name,
         pg_catalog.format('%I.agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint)',target_schema), 'EXECUTE') THEN
      RAISE EXCEPTION 'REFUSE: untrusted role can reconcile finality: %', role_name;
    END IF;
  END LOOP;
  FOR role_name IN SELECT unnest(ARRAY['av_model_b_reader', 'av_model_b_finalizer']) LOOP
    IF pg_catalog.has_function_privilege(role_name,
      pg_catalog.format('%I.agentvault_model_b_claim_guarded(text,text,text,text,text,text)',target_schema), 'EXECUTE') OR
       pg_catalog.has_function_privilege(role_name,
      pg_catalog.format('%I.agentvault_model_b_prepare_guarded(text,bytea,text,text,bigint,text,text,text,text,text)',target_schema), 'EXECUTE') OR
       pg_catalog.has_function_privilege(role_name,
      pg_catalog.format('%I.agentvault_model_b_reserve_guarded(text)',target_schema), 'EXECUTE') THEN
      RAISE EXCEPTION 'REFUSE: non-coordinator role can prepare or reserve: %', role_name;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege('av_model_b_coordinator',
      pg_catalog.format('%I.agentvault_model_b_claim_guarded(text,text,text,text,text,text)',target_schema), 'EXECUTE') OR
     NOT pg_catalog.has_function_privilege('av_model_b_coordinator',
      pg_catalog.format('%I.agentvault_model_b_prepare_guarded(text,bytea,text,text,bigint,text,text,text,text,text)',target_schema), 'EXECUTE') OR
     NOT pg_catalog.has_function_privilege('av_model_b_coordinator',
      pg_catalog.format('%I.agentvault_model_b_reserve_guarded(text)',target_schema), 'EXECUTE') OR
     NOT pg_catalog.has_function_privilege('av_model_b_finalizer',
      pg_catalog.format('%I.agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint)',target_schema), 'EXECUTE') THEN
    RAISE EXCEPTION 'REFUSE: guarded functions not executable by designated roles';
  END IF;
END
$av76c8$;

COMMIT;
