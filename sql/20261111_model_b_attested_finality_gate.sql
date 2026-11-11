-- 7.6D.9 TEST-ONLY: independently keyed, two-witness SQL terminal gate.
-- NOT a Solana consensus proof or a production-ready finality mechanism.
-- Use only in a disposable private schema of an agentvault_test* local database.
-- Requires D.8 quarantine and DBA-provisioned NOLOGIN roles, as well as pgcrypto.
-- Witness keys are supplied ONLY by the test schema owner after installation.
-- Never run this SQL or insert real witness secrets into an active database.
BEGIN;

DO $av76d9$
DECLARE
  target_schema name := pg_catalog.current_schema();
  table_oid oid;
  table_owner oid;
  quarantine_oid oid;
  quarantine_source text;
  crypto_schema name;
  crypto_extension oid;
  role_name text;
  fn_oid oid;
BEGIN
  IF pg_catalog.current_database() !~ '^agentvault_test[a-zA-Z0-9_]*$'
      OR target_schema IS NULL
      OR target_schema IN ('public', 'pg_catalog', 'information_schema')
      OR target_schema LIKE 'pg_temp_%' THEN
    RAISE EXCEPTION 'REFUSE: evidence gate requires disposable private agentvault_test* schema';
  END IF;
  SELECT c.oid, c.relowner INTO table_oid, table_owner
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = target_schema::pg_catalog.regnamespace
     AND c.relname = 'agentvault_model_b_payment_requests' AND c.relkind = 'r';
  IF table_oid IS NULL OR table_owner <> CURRENT_USER::pg_catalog.regrole::oid
      OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_namespace n
         WHERE n.nspname = target_schema AND n.nspowner = table_owner
      ) THEN
    RAISE EXCEPTION 'REFUSE: payment schema and table owner required';
  END IF;
  IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.relnamespace = target_schema::pg_catalog.regnamespace
        AND c.relname IN ('agentvault_model_b_evidence_keys')
    ) OR pg_catalog.to_regprocedure(pg_catalog.format(
      '%I.agentvault_model_b_attested_finality_guarded(text,text,bigint,text,text)',
      target_schema)) IS NOT NULL THEN
    RAISE EXCEPTION 'REFUSE: evidence gate already installed or name in use';
  END IF;

  quarantine_oid := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint)',
    target_schema));
  IF quarantine_oid IS NULL THEN
    RAISE EXCEPTION 'REFUSE: D.8 quarantine function not found';
  END IF;
  SELECT pg_catalog.pg_get_functiondef(p.oid) INTO quarantine_source
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE p.oid = quarantine_oid AND p.proowner = table_owner
      AND p.prosecdef AND l.lanname = 'sql'
      AND 'search_path=pg_catalog' = ANY(p.proconfig);
  IF quarantine_source IS NULL OR quarantine_source !~ 'SET phase = ''UNRESOLVED'''
      OR quarantine_source ~ 'SET phase = \$11' THEN
    RAISE EXCEPTION 'REFUSE: D.8 finality quarantine is not installed';
  END IF;
  IF NOT pg_catalog.has_function_privilege('av_model_b_finalizer', quarantine_oid, 'EXECUTE')
      OR pg_catalog.has_function_privilege('av_model_b_reader', quarantine_oid, 'EXECUTE')
      OR pg_catalog.has_function_privilege('av_model_b_coordinator', quarantine_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'REFUSE: existing finalizer ACL is unsafe';
  END IF;

  SELECT e.oid, n.nspname INTO crypto_extension, crypto_schema
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pgcrypto';
  IF crypto_extension IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND d.objid = p.oid AND d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
        AND d.refobjid = crypto_extension AND d.deptype = 'e'
      WHERE p.pronamespace = crypto_schema::pg_catalog.regnamespace
        AND p.proname = 'hmac'
        AND p.oid = pg_catalog.to_regprocedure(pg_catalog.format('%I.hmac(bytea,bytea,text)',crypto_schema))
    ) THEN
    RAISE EXCEPTION 'REFUSE: trusted pgcrypto.hmac(bytea,bytea,text) is required';
  END IF;
  FOREACH role_name IN ARRAY ARRAY[
    'av_model_b_reader','av_model_b_coordinator','av_model_b_finalizer'
  ] LOOP
    IF pg_catalog.has_schema_privilege(role_name, target_schema, 'CREATE')
       OR pg_catalog.has_schema_privilege(role_name, crypto_schema, 'CREATE')
       OR pg_catalog.pg_has_role(role_name::pg_catalog.regrole, table_owner, 'MEMBER')
       OR pg_catalog.has_database_privilege(role_name, pg_catalog.current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'REFUSE: unsafe object creation/ownership privilege for %', role_name;
    END IF;
  END LOOP;

  -- No witness key is inserted or embedded by this migration.
  EXECUTE pg_catalog.format($ddl$
    CREATE TABLE %1$I.agentvault_model_b_evidence_keys (
      witness_id text PRIMARY KEY CHECK (witness_id IN ('observer_a','observer_b')),
      shared_secret bytea NOT NULL CHECK (pg_catalog.octet_length(shared_secret) = 32)
    )
  $ddl$, target_schema);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON TABLE %I.agentvault_model_b_evidence_keys FROM PUBLIC, av_model_b_reader, av_model_b_coordinator, av_model_b_finalizer',
    target_schema);

  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION %1$I.agentvault_model_b_attested_finality_guarded(
      p_request_id text, p_status text, p_slot bigint, p_mac_a text, p_mac_b text)
    RETURNS SETOF %1$I.agentvault_model_b_payment_requests
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE
      payment_row %1$I.agentvault_model_b_payment_requests%%ROWTYPE;
      secret_a bytea;
      secret_b bytea;
      signed_payload text;
    BEGIN
      IF p_status NOT IN ('CONFIRMED','FAILED') OR p_slot IS NULL OR p_slot < 0
         OR p_mac_a !~ '^[0-9a-f]{64}$' OR p_mac_b !~ '^[0-9a-f]{64}$'
         OR p_mac_a IS NULL OR p_mac_b IS NULL THEN
        RETURN;
      END IF;
      SELECT * INTO payment_row FROM %1$I.agentvault_model_b_payment_requests
       WHERE request_id = p_request_id FOR UPDATE;
      IF NOT FOUND OR payment_row.phase NOT IN ('SUBMISSION_RESERVED','UNRESOLVED')
         OR payment_row.signed_tx_bytes IS NULL
         OR payment_row.signed_tx_sha256 IS NULL
         OR payment_row.tx_signature IS NULL
         OR payment_row.last_valid_block_height IS NULL
         OR pg_catalog.encode(pg_catalog.sha256(payment_row.signed_tx_bytes),'hex')
               <> payment_row.signed_tx_sha256 THEN
        RETURN;
      END IF;
      SELECT shared_secret INTO secret_a FROM %1$I.agentvault_model_b_evidence_keys
        WHERE witness_id = 'observer_a';
      SELECT shared_secret INTO secret_b FROM %1$I.agentvault_model_b_evidence_keys
        WHERE witness_id = 'observer_b';
      IF secret_a IS NULL OR secret_b IS NULL OR secret_a = secret_b THEN
        RETURN;
      END IF;

      -- Versioned, length-prefixed UTF-8 fields; unambiguous even when a
      -- stored field contains a delimiter or non-ASCII characters.
      signed_payload := 'AgentVault/ModelB/finality-attestation/v1|' ||
        pg_catalog.octet_length(pg_catalog.convert_to(payment_row.request_id, 'UTF8'))::text || ':' || payment_row.request_id
        || pg_catalog.octet_length(pg_catalog.convert_to(payment_row.genesis_hash, 'UTF8'))::text || ':' || payment_row.genesis_hash
        || pg_catalog.octet_length(pg_catalog.convert_to(payment_row.program_id, 'UTF8'))::text || ':' || payment_row.program_id
        || pg_catalog.octet_length(pg_catalog.convert_to(payment_row.vault, 'UTF8'))::text || ':' || payment_row.vault
        || pg_catalog.octet_length(pg_catalog.convert_to(payment_row.workflow_digest, 'UTF8'))::text || ':' || payment_row.workflow_digest
        || pg_catalog.octet_length(pg_catalog.convert_to(payment_row.payment_digest, 'UTF8'))::text || ':' || payment_row.payment_digest
        || pg_catalog.octet_length(pg_catalog.convert_to(payment_row.signed_tx_sha256, 'UTF8'))::text || ':' || payment_row.signed_tx_sha256
        || pg_catalog.octet_length(pg_catalog.convert_to(payment_row.tx_signature, 'UTF8'))::text || ':' || payment_row.tx_signature
        || pg_catalog.octet_length(pg_catalog.convert_to(payment_row.last_valid_block_height::text, 'UTF8'))::text || ':' || payment_row.last_valid_block_height::text
        || pg_catalog.octet_length(pg_catalog.convert_to(p_status, 'UTF8'))::text || ':' || p_status
        || pg_catalog.octet_length(pg_catalog.convert_to(p_slot::text, 'UTF8'))::text || ':' || p_slot::text;
      -- The caller's terminal status/slot is cryptographically bound to
      -- the *stored*, immutable payment identity and SHA-256 of exact bytes.
      IF pg_catalog.encode(%2$I.hmac(
           pg_catalog.convert_to(signed_payload,'UTF8'), secret_a, 'sha256'),'hex') <> p_mac_a
          OR pg_catalog.encode(%2$I.hmac(
           pg_catalog.convert_to(signed_payload,'UTF8'), secret_b, 'sha256'),'hex') <> p_mac_b THEN
        RETURN;
      END IF;

      RETURN QUERY UPDATE %1$I.agentvault_model_b_payment_requests
         SET phase = p_status, finalized_slot = p_slot,
             finality_observed_at = pg_catalog.clock_timestamp()
       WHERE request_id = p_request_id
         AND phase IN ('SUBMISSION_RESERVED','UNRESOLVED')
         AND signed_tx_sha256 = payment_row.signed_tx_sha256
         AND tx_signature = payment_row.tx_signature
         AND finalized_slot IS NULL
       RETURNING *;
    END
    $body$;
  $ddl$, target_schema, crypto_schema);

  -- CREATE FUNCTION normally grants PUBLIC EXECUTE; revoke before COMMIT.
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %I.agentvault_model_b_attested_finality_guarded(text,text,bigint,text,text) FROM PUBLIC',
    target_schema);
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION %I.agentvault_model_b_attested_finality_guarded(text,text,bigint,text,text) TO av_model_b_finalizer',
    target_schema);

  fn_oid := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.agentvault_model_b_attested_finality_guarded(text,text,bigint,text,text)',
    target_schema));
  IF fn_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
       WHERE p.oid = fn_oid AND p.proowner = table_owner AND p.prosecdef
         AND 'search_path=pg_catalog' = ANY(p.proconfig)
         AND p.prolang = (SELECT l.oid FROM pg_catalog.pg_language l WHERE l.lanname='plpgsql')
    ) OR pg_catalog.has_function_privilege('av_model_b_reader',fn_oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('av_model_b_coordinator',fn_oid,'EXECUTE')
      OR NOT pg_catalog.has_function_privilege('av_model_b_finalizer',fn_oid,'EXECUTE') THEN
    RAISE EXCEPTION 'REFUSE: attested finality routine owner or ACL is unsafe';
  END IF;
  FOREACH role_name IN ARRAY ARRAY[
    'av_model_b_reader','av_model_b_coordinator','av_model_b_finalizer'
  ] LOOP
    IF pg_catalog.has_table_privilege(role_name,
      pg_catalog.format('%I.agentvault_model_b_evidence_keys',target_schema),'SELECT')
      OR pg_catalog.has_table_privilege(role_name,
      pg_catalog.format('%I.agentvault_model_b_evidence_keys',target_schema),'INSERT')
      OR pg_catalog.has_table_privilege(role_name,
      pg_catalog.format('%I.agentvault_model_b_evidence_keys',target_schema),'UPDATE')
      OR pg_catalog.has_table_privilege(role_name,
      pg_catalog.format('%I.agentvault_model_b_evidence_keys',target_schema),'DELETE') THEN
      RAISE EXCEPTION 'REFUSE: runtime role has witness-key access: %',role_name;
    END IF;
  END LOOP;
END
$av76d9$;
COMMIT;
