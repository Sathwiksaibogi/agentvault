-- AgentVault 7.6D.12B: OPTIONAL, TEST-ONLY PostgreSQL-side Ed25519 finality gate.
-- This migration deliberately REFUSES installation when an extension-owned,
-- approved pgsodium.crypto_sign_verify_detached(bytea,bytea,bytea) is absent.
-- Only execute in a disposable, private schema of a local agentvault_test* DB.
-- Do not install extensions, expose real keys, or activate live payment traffic.
-- Requires D.8 quarantine and D.9 HMAC prototype; the old HMAC EXECUTE is
-- revoked within the SAME transaction before granting the Ed25519 gate.
BEGIN;
DO $av76d12b$
DECLARE
  s name := pg_catalog.current_schema();
  t oid;
  owner_oid oid;
  quarantine_fn oid;
  hmac_fn oid;
  crypto_ext oid;
  crypto_schema name;
  verifier_fn oid;
  role_name text;
  column_name text;
  terminal_exists boolean;
  source_definition text;
  new_fn oid;
  helper_fn oid;
BEGIN
  IF pg_catalog.current_database() !~ '^agentvault_test[a-zA-Z0-9_]*$'
     OR s IS NULL OR s IN ('public','pg_catalog','information_schema')
     OR s LIKE 'pg_temp_%' THEN
    RAISE EXCEPTION 'REFUSE: Ed25519 gate is for disposable private agentvault_test* schemas only';
  END IF;
  SELECT c.oid, c.relowner INTO t, owner_oid FROM pg_catalog.pg_class c
    WHERE c.relnamespace = s::pg_catalog.regnamespace
      AND c.relname = 'agentvault_model_b_payment_requests' AND c.relkind = 'r';
  IF t IS NULL OR owner_oid <> CURRENT_USER::pg_catalog.regrole::oid
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
                    WHERE n.nspname=s AND n.nspowner=owner_oid) THEN
    RAISE EXCEPTION 'REFUSE: only the payment table and private schema owner may install';
  END IF;
  EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %I.agentvault_model_b_payment_requests WHERE phase IN (''CONFIRMED'',''FAILED''))',s)
    INTO terminal_exists;
  IF terminal_exists THEN
    RAISE EXCEPTION 'REFUSE: existing terminal rows need independent review';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.format('%I.agentvault_model_b_asymmetric_witness_keys',s)) IS NOT NULL
    OR pg_catalog.to_regclass(pg_catalog.format('%I.agentvault_model_b_asymmetric_policy',s)) IS NOT NULL
    OR pg_catalog.to_regprocedure(pg_catalog.format('%I.agentvault_model_b_ed25519_payload(%I.agentvault_model_b_payment_requests,text,bigint,text,text,bigint)',s,s)) IS NOT NULL
    OR pg_catalog.to_regprocedure(pg_catalog.format('%I.agentvault_model_b_ed25519_finality_guarded(text,text,bigint,text,bigint,text,text,bigint,text)',s)) IS NOT NULL THEN
    RAISE EXCEPTION 'REFUSE: asymmetric gate objects already exist';
  END IF;
  quarantine_fn := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint)',s));
  hmac_fn := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.agentvault_model_b_attested_finality_guarded(text,text,bigint,text,text)',s));
  IF quarantine_fn IS NULL OR hmac_fn IS NULL THEN
    RAISE EXCEPTION 'REFUSE: D.8 quarantine and D.9 HMAC test gate required';
  END IF;
  SELECT pg_catalog.pg_get_functiondef(p.oid) INTO source_definition
    FROM pg_catalog.pg_proc p WHERE p.oid=quarantine_fn AND p.proowner=owner_oid
      AND p.prosecdef AND 'search_path=pg_catalog'=ANY(p.proconfig);
  IF source_definition IS NULL OR source_definition !~ 'SET phase = ''UNRESOLVED'''
     OR source_definition ~ 'SET phase = \$11' THEN
    RAISE EXCEPTION 'REFUSE: original D.8 unauthenticated terminal path is not quarantined';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=hmac_fn
                 AND p.proowner=owner_oid AND p.prosecdef
                 AND 'search_path=pg_catalog'=ANY(p.proconfig)) THEN
    RAISE EXCEPTION 'REFUSE: unexpected legacy HMAC gate owner';
  END IF;
  -- The verifier must belong to the actual installed pgsodium extension;
  -- similarly named user-created functions are NOT trusted.
  SELECT e.oid, n.nspname INTO crypto_ext,crypto_schema
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname='pgsodium';
  IF crypto_ext IS NULL THEN
    RAISE EXCEPTION 'REFUSE: vetted installed pgsodium is required for database Ed25519 verification';
  END IF;
  verifier_fn := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.crypto_sign_verify_detached(bytea,bytea,bytea)',crypto_schema));
  IF verifier_fn IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_proc'::pg_catalog.regclass
      AND d.objid=p.oid AND d.refclassid='pg_catalog.pg_extension'::pg_catalog.regclass
      AND d.refobjid=crypto_ext AND d.deptype='e'
    WHERE p.oid=verifier_fn AND p.prorettype='boolean'::pg_catalog.regtype
  ) OR NOT pg_catalog.has_function_privilege(CURRENT_USER,verifier_fn,'EXECUTE')
    OR NOT pg_catalog.has_schema_privilege(CURRENT_USER,crypto_schema,'USAGE') THEN
    RAISE EXCEPTION 'REFUSE: trusted extension-owned Ed25519 verifier is unavailable';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['av_model_b_reader','av_model_b_coordinator','av_model_b_finalizer'] LOOP
    IF pg_catalog.has_schema_privilege(role_name,s,'CREATE')
       OR pg_catalog.has_schema_privilege(role_name,crypto_schema,'CREATE')
       OR pg_catalog.has_database_privilege(role_name,pg_catalog.current_database(),'CREATE')
       OR pg_catalog.pg_has_role(role_name::pg_catalog.regrole,owner_oid,'MEMBER') THEN
      RAISE EXCEPTION 'REFUSE: unsafe runtime role/schema privilege: %',role_name;
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege('av_model_b_finalizer',t,'UPDATE')
     OR pg_catalog.has_table_privilege('av_model_b_finalizer',t,'INSERT')
     OR pg_catalog.has_table_privilege('av_model_b_finalizer',t,'DELETE') THEN
    RAISE EXCEPTION 'REFUSE: finalizer has direct table mutation privilege';
  END IF;
  FOR column_name IN SELECT a.attname FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=t AND a.attnum>0 AND NOT a.attisdropped LOOP
    IF pg_catalog.has_column_privilege('av_model_b_finalizer',t,column_name,'UPDATE')
       OR pg_catalog.has_column_privilege('av_model_b_finalizer',t,column_name,'INSERT') THEN
      RAISE EXCEPTION 'REFUSE: finalizer has direct column mutation privilege';
    END IF;
  END LOOP;

  EXECUTE pg_catalog.format($ddl$
    CREATE TABLE %1$I.agentvault_model_b_asymmetric_policy (
      singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      generation bigint NOT NULL CHECK (generation > 0 AND generation <= 9007199254740991)
    )
  $ddl$,s);
  EXECUTE pg_catalog.format($ddl$
    CREATE TABLE %1$I.agentvault_model_b_asymmetric_witness_keys (
      witness_id text NOT NULL CHECK (witness_id IN ('observer_a','observer_b')),
      key_id text NOT NULL UNIQUE CHECK (key_id ~ '^[a-z][a-z0-9_-]{7,63}$'),
      generation bigint NOT NULL CHECK (generation > 0 AND generation <= 9007199254740991),
      public_key bytea NOT NULL UNIQUE CHECK (pg_catalog.octet_length(public_key)=32),
      state text NOT NULL CHECK (state IN ('ACTIVE','REVOKED')),
      PRIMARY KEY (witness_id,generation)
    )
  $ddl$,s);
  EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I.agentvault_model_b_asymmetric_policy FROM PUBLIC,av_model_b_reader,av_model_b_coordinator,av_model_b_finalizer',s);
  EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I.agentvault_model_b_asymmetric_witness_keys FROM PUBLIC,av_model_b_reader,av_model_b_coordinator,av_model_b_finalizer',s);

  -- Canonical v2 signing payload exactly mirrors demo/model-b-finality-ed25519.ts.
  -- The row is passed from locked payment storage; never accept serialized
  -- identity fields from the finalizer, nor accept caller-supplied public keys.
  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION %1$I.agentvault_model_b_ed25519_payload(
      p %1$I.agentvault_model_b_payment_requests, outcome text, slot bigint,
      witness text, key_id text, generation bigint)
    RETURNS bytea LANGUAGE sql STRICT IMMUTABLE SET search_path=pg_catalog AS $body$
      SELECT pg_catalog.convert_to(
        'AgentVault/ModelB/finality-attestation/ed25519/v2|'
        || pg_catalog.octet_length(pg_catalog.convert_to(witness,'UTF8'))::text || ':' || witness
        || pg_catalog.octet_length(pg_catalog.convert_to(key_id,'UTF8'))::text || ':' || key_id
        || pg_catalog.octet_length(pg_catalog.convert_to(generation::text,'UTF8'))::text || ':' || generation::text
        || 'AgentVault/ModelB/finality-attestation/v1|'
        || pg_catalog.octet_length(pg_catalog.convert_to((p).request_id,'UTF8'))::text || ':' || (p).request_id
        || pg_catalog.octet_length(pg_catalog.convert_to((p).genesis_hash,'UTF8'))::text || ':' || (p).genesis_hash
        || pg_catalog.octet_length(pg_catalog.convert_to((p).program_id,'UTF8'))::text || ':' || (p).program_id
        || pg_catalog.octet_length(pg_catalog.convert_to((p).vault,'UTF8'))::text || ':' || (p).vault
        || pg_catalog.octet_length(pg_catalog.convert_to((p).workflow_digest,'UTF8'))::text || ':' || (p).workflow_digest
        || pg_catalog.octet_length(pg_catalog.convert_to((p).payment_digest,'UTF8'))::text || ':' || (p).payment_digest
        || pg_catalog.octet_length(pg_catalog.convert_to((p).signed_tx_sha256,'UTF8'))::text || ':' || (p).signed_tx_sha256
        || pg_catalog.octet_length(pg_catalog.convert_to((p).tx_signature,'UTF8'))::text || ':' || (p).tx_signature
        || pg_catalog.octet_length(pg_catalog.convert_to((p).last_valid_block_height::text,'UTF8'))::text || ':' || (p).last_valid_block_height::text
        || pg_catalog.octet_length(pg_catalog.convert_to(outcome,'UTF8'))::text || ':' || outcome
        || pg_catalog.octet_length(pg_catalog.convert_to(slot::text,'UTF8'))::text || ':' || slot::text
      ,'UTF8');
    $body$
  $ddl$,s);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %1$I.agentvault_model_b_ed25519_payload(%1$I.agentvault_model_b_payment_requests,text,bigint,text,text,bigint) FROM PUBLIC',s);

  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION %1$I.agentvault_model_b_ed25519_finality_guarded(
      p_request_id text,p_status text,p_slot bigint,
      p_key_a text,p_generation_a bigint,p_signature_a text,
      p_key_b text,p_generation_b bigint,p_signature_b text)
    RETURNS SETOF %1$I.agentvault_model_b_payment_requests
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
    DECLARE
      payment %1$I.agentvault_model_b_payment_requests%%ROWTYPE;
      active_generation bigint;
      pub_a bytea;
      pub_b bytea;
      message_a bytea;
      message_b bytea;
    BEGIN
      IF p_status IS NULL OR p_status NOT IN ('CONFIRMED','FAILED')
         OR p_slot IS NULL OR p_slot < 0 OR p_slot > 9007199254740991
         OR p_key_a IS NULL OR p_key_b IS NULL OR p_key_a = p_key_b
         OR p_key_a !~ '^[a-z][a-z0-9_-]{7,63}$'
         OR p_key_b !~ '^[a-z][a-z0-9_-]{7,63}$'
         OR p_signature_a IS NULL OR p_signature_b IS NULL
         OR p_signature_a !~ '^[0-9a-f]{128}$' OR p_signature_b !~ '^[0-9a-f]{128}$'
         OR p_generation_a IS NULL OR p_generation_a <= 0
         OR p_generation_b IS NULL OR p_generation_a <> p_generation_b THEN
        RETURN;
      END IF;
      SELECT * INTO payment FROM %1$I.agentvault_model_b_payment_requests
        WHERE request_id=p_request_id FOR UPDATE;
      IF NOT FOUND OR payment.phase NOT IN ('SUBMISSION_RESERVED','UNRESOLVED')
         OR payment.finalized_slot IS NOT NULL OR payment.signed_tx_bytes IS NULL
         OR payment.signed_tx_sha256 IS NULL OR payment.tx_signature IS NULL
         OR payment.last_valid_block_height IS NULL
         OR pg_catalog.encode(pg_catalog.sha256(payment.signed_tx_bytes),'hex') <> payment.signed_tx_sha256 THEN
        RETURN;
      END IF;
      SELECT generation INTO active_generation
        FROM %1$I.agentvault_model_b_asymmetric_policy WHERE singleton=TRUE FOR SHARE;
      IF active_generation IS NULL OR active_generation <> p_generation_a THEN RETURN; END IF;
      IF (SELECT pg_catalog.count(*) FROM %1$I.agentvault_model_b_asymmetric_witness_keys
          WHERE generation=active_generation AND state='ACTIVE') <> 2 THEN RETURN; END IF;
      SELECT public_key INTO pub_a FROM %1$I.agentvault_model_b_asymmetric_witness_keys
        WHERE witness_id='observer_a' AND key_id=p_key_a
          AND generation=active_generation AND state='ACTIVE' FOR SHARE;
      SELECT public_key INTO pub_b FROM %1$I.agentvault_model_b_asymmetric_witness_keys
        WHERE witness_id='observer_b' AND key_id=p_key_b
          AND generation=active_generation AND state='ACTIVE' FOR SHARE;
      IF pub_a IS NULL OR pub_b IS NULL OR pub_a=pub_b THEN RETURN; END IF;
      message_a := %1$I.agentvault_model_b_ed25519_payload(
        payment,p_status,p_slot,'observer_a',p_key_a,p_generation_a);
      message_b := %1$I.agentvault_model_b_ed25519_payload(
        payment,p_status,p_slot,'observer_b',p_key_b,p_generation_b);
      IF %2$I.crypto_sign_verify_detached(
           pg_catalog.decode(p_signature_a,'hex'),message_a,pub_a) IS DISTINCT FROM TRUE
         OR %2$I.crypto_sign_verify_detached(
           pg_catalog.decode(p_signature_b,'hex'),message_b,pub_b) IS DISTINCT FROM TRUE THEN
        RETURN;
      END IF;
      RETURN QUERY UPDATE %1$I.agentvault_model_b_payment_requests
        SET phase=p_status, finalized_slot=p_slot,
            finality_observed_at=pg_catalog.clock_timestamp()
        WHERE request_id=p_request_id
          AND phase IN ('SUBMISSION_RESERVED','UNRESOLVED')
          AND finalized_slot IS NULL
          AND signed_tx_sha256=payment.signed_tx_sha256
          AND tx_signature=payment.tx_signature
        RETURNING *;
    END
    $body$;
  $ddl$,s,crypto_schema);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %I.agentvault_model_b_ed25519_finality_guarded(text,text,bigint,text,bigint,text,text,bigint,text) FROM PUBLIC',s);
  -- IMPORTANT: Remove finalizer access to the older HMAC-only gate before
  -- granting Ed25519. If unexpected grants remain, abort and roll back ALL.
  EXECUTE pg_catalog.format(
    'REVOKE EXECUTE ON FUNCTION %I.agentvault_model_b_attested_finality_guarded(text,text,bigint,text,text) FROM PUBLIC,av_model_b_reader,av_model_b_coordinator,av_model_b_finalizer',s);
  IF pg_catalog.has_function_privilege('av_model_b_finalizer',hmac_fn,'EXECUTE')
     OR pg_catalog.has_function_privilege('av_model_b_reader',hmac_fn,'EXECUTE')
     OR pg_catalog.has_function_privilege('av_model_b_coordinator',hmac_fn,'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
                LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
                  pg_catalog.acldefault('f',p.proowner))) a
                  WHERE p.oid=hmac_fn AND a.privilege_type='EXECUTE'
                    AND a.grantee<>p.proowner) THEN
    RAISE EXCEPTION 'REFUSE: old HMAC finality gate retains effective EXECUTE grants';
  END IF;
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION %I.agentvault_model_b_ed25519_finality_guarded(text,text,bigint,text,bigint,text,text,bigint,text) TO av_model_b_finalizer',s);
  new_fn := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.agentvault_model_b_ed25519_finality_guarded(text,text,bigint,text,bigint,text,text,bigint,text)',s));
  helper_fn := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.agentvault_model_b_ed25519_payload(%I.agentvault_model_b_payment_requests,text,bigint,text,text,bigint)',s,s));
  IF new_fn IS NULL OR helper_fn IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                    WHERE p.oid=new_fn AND p.proowner=owner_oid AND p.prosecdef
                      AND 'search_path=pg_catalog'=ANY(p.proconfig))
     OR pg_catalog.has_function_privilege('av_model_b_reader',new_fn,'EXECUTE')
     OR pg_catalog.has_function_privilege('av_model_b_coordinator',new_fn,'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('av_model_b_finalizer',new_fn,'EXECUTE')
     OR pg_catalog.has_function_privilege('av_model_b_finalizer',helper_fn,'EXECUTE') THEN
    RAISE EXCEPTION 'REFUSE: asymmetric finality gate ownership/ACL audit failed';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['av_model_b_reader','av_model_b_coordinator','av_model_b_finalizer'] LOOP
    IF pg_catalog.has_table_privilege(role_name,
          pg_catalog.format('%I.agentvault_model_b_asymmetric_witness_keys',s),'SELECT')
       OR pg_catalog.has_table_privilege(role_name,
          pg_catalog.format('%I.agentvault_model_b_asymmetric_witness_keys',s),'UPDATE')
       OR pg_catalog.has_table_privilege(role_name,
          pg_catalog.format('%I.agentvault_model_b_asymmetric_policy',s),'SELECT') THEN
      RAISE EXCEPTION 'REFUSE: runtime role has access to trusted key registry';
    END IF;
  END LOOP;
END
$av76d12b$;
COMMIT;
