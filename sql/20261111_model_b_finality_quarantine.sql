-- AgentVault 7.6D.8: FAIL-CLOSED containment of an untrusted finalizer.
-- TEST DATABASES ONLY. Do not apply to production or migrate an active payment
-- database without a reviewed operational plan. This intentionally disables
-- future CONFIRMED/FAILED SQL transitions, including legitimate finality.
-- Requires the existing guarded-write migration and a dedicated private schema.
-- Run once as the schema/table owner, inside a local agentvault_test* database.
-- It never edits payment rows, unlocks requests, or changes signed tx bytes.
BEGIN;

DO $av76d8$
DECLARE
  target_schema name := pg_catalog.current_schema();
  table_oid oid;
  table_owner oid;
  fn_oid oid;
  fn_source text;
  has_terminal boolean;
BEGIN
  IF pg_catalog.current_database() !~ '^agentvault_test[a-zA-Z0-9_]*$'
     OR target_schema IS NULL
     OR target_schema IN ('public', 'pg_catalog', 'information_schema')
     OR target_schema LIKE 'pg_temp_%' THEN
    RAISE EXCEPTION 'REFUSE: quarantine is only for a private agentvault_test* schema';
  END IF;

  SELECT c.oid, c.relowner INTO table_oid, table_owner
  FROM pg_catalog.pg_class c
  WHERE c.relnamespace = target_schema::pg_catalog.regnamespace
    AND c.relname = 'agentvault_model_b_payment_requests'
    AND c.relkind = 'r';

  IF table_oid IS NULL
     OR table_owner <> CURRENT_USER::pg_catalog.regrole::oid
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_namespace n
       WHERE n.nspname = target_schema AND n.nspowner = table_owner
     ) THEN
    RAISE EXCEPTION 'REFUSE: quarantine requires the private schema and table owner';
  END IF;

  -- Existing terminal rows cannot be retroactively certified as genuine.
  EXECUTE pg_catalog.format(
    'SELECT EXISTS (SELECT 1 FROM %I.agentvault_model_b_payment_requests WHERE phase IN (''CONFIRMED'', ''FAILED''))',
    target_schema) INTO has_terminal;
  IF has_terminal THEN
    RAISE EXCEPTION 'REFUSE: terminal rows require independent review before quarantine';
  END IF;

  fn_oid := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint)',
    target_schema));
  IF fn_oid IS NULL THEN
    RAISE EXCEPTION 'REFUSE: guarded finalizer function is missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(p.oid) INTO fn_source
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang
  WHERE p.oid = fn_oid AND p.proowner = table_owner
    AND p.prosecdef AND l.lanname = 'sql'
    AND 'search_path=pg_catalog' = ANY(p.proconfig);

  -- Refuse to overwrite an already-modified or independently hardened body.
  IF fn_source IS NULL
     OR fn_source !~ 'SET phase = \$11, finalized_slot = \$12'
     OR fn_source !~ 'signed_tx_bytes = \$10' THEN
    RAISE EXCEPTION 'REFUSE: unexpected guarded finalizer implementation';
  END IF;

  IF NOT pg_catalog.has_function_privilege('av_model_b_finalizer', fn_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('av_model_b_reader', fn_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('av_model_b_coordinator', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'REFUSE: expected finalizer role permissions are missing';
  END IF;

  -- Same signature, return type, owner, and ACL. Keep SQL language and the
  -- fixed search_path expected by the existing privilege audit.
  -- No terminal update is reachable, regardless of claimed finalized slot.
  EXECUTE pg_catalog.format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.agentvault_model_b_reconcile_guarded(
      text, text, text, text, text, text, text, text, bigint, bytea, text, bigint)
    RETURNS SETOF %1$I.agentvault_model_b_payment_requests
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $body$
      UPDATE %1$I.agentvault_model_b_payment_requests
         SET phase = 'UNRESOLVED', finalized_slot = NULL,
             finality_observed_at = NULL
       WHERE request_id = $1 AND genesis_hash = $2 AND program_id = $3
         AND vault = $4 AND workflow_digest = $5 AND payment_digest = $6
         AND signed_tx_sha256 = $7 AND tx_signature = $8
         AND last_valid_block_height = $9 AND signed_tx_bytes = $10
         AND phase = 'SUBMISSION_RESERVED'
         AND $11 = 'UNRESOLVED' AND $12 IS NULL
       RETURNING *;
    $body$;
  $ddl$, target_schema);

  -- No new functions, DML permissions, or role grants. Existing runtime
  -- finality callers asking for CONFIRMED/FAILED now fail closed (0 rows).
  IF pg_catalog.pg_get_functiondef(fn_oid) !~ 'SET phase = ''UNRESOLVED'''
     OR pg_catalog.pg_get_functiondef(fn_oid) ~ 'SET phase = \$11' THEN
    RAISE EXCEPTION 'REFUSE: quarantine function replacement not installed';
  END IF;
END
$av76d8$;

COMMIT;
