-- AgentVault 7.6C.10: READ-ONLY, fail-closed PostgreSQL privilege audit.
-- Run after 7.6C.8 guarded writes in a dedicated private schema.
-- Runs as the migration/table owner. This script does NOT GRANT, REVOKE,
-- deploy services, authenticate Solana signatures, or validate RPC evidence.
-- A green audit does not mean coordinator/finalizer credentials are safe if stolen.
DO $av76c10$
DECLARE
  target_schema name := pg_catalog.current_schema();
  schema_owner oid;
  table_oid oid;
  table_owner oid;
  guard_oid oid;
  role_name text;
  other_role text;
  column_name text;
  fn_signature text;
  fn_allowed_role text;
  fn_oid oid;
  fn_owner oid;
  fn_is_definer boolean;
  fn_settings text[];
  fn_language oid;
  approved_oids oid[] := ARRAY[]::oid[];
BEGIN
  IF target_schema IS NULL OR target_schema IN ('public', 'pg_catalog', 'information_schema')
     OR target_schema LIKE 'pg_temp_%' THEN
    RAISE EXCEPTION 'REFUSE: audit requires a private schema';
  END IF;

  SELECT n.nspowner INTO schema_owner
    FROM pg_catalog.pg_namespace n WHERE n.nspname = target_schema;
  SELECT c.oid, c.relowner INTO table_oid, table_owner
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = target_schema::pg_catalog.regnamespace
     AND c.relname = 'agentvault_model_b_payment_requests'
     AND c.relkind = 'r';
  IF table_oid IS NULL OR table_owner <> current_user::pg_catalog.regrole::oid
     OR schema_owner IS DISTINCT FROM table_owner THEN
    RAISE EXCEPTION 'REFUSE: payment table/schema must have the same migration owner';
  END IF;

  -- Validate the complete role graph, including indirect SET ROLE membership.
  FOREACH role_name IN ARRAY ARRAY[
    'av_model_b_reader', 'av_model_b_coordinator', 'av_model_b_finalizer'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r
       WHERE r.rolname = role_name
         AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
             OR r.rolreplication OR r.rolbypassrls OR r.rolcanlogin)
    ) THEN
      RAISE EXCEPTION 'REFUSE: % must be an unprivileged NOLOGIN role', role_name;
    END IF;
    IF pg_catalog.pg_has_role(role_name::pg_catalog.regrole, table_owner, 'MEMBER')
       OR pg_catalog.has_schema_privilege(role_name, target_schema, 'CREATE')
       OR pg_catalog.has_database_privilege(role_name, pg_catalog.current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'REFUSE: % can reach owner or object creation privilege', role_name;
    END IF;
    FOREACH other_role IN ARRAY ARRAY[
      'av_model_b_reader', 'av_model_b_coordinator', 'av_model_b_finalizer'
    ] LOOP
      IF role_name <> other_role AND
         pg_catalog.pg_has_role(role_name::pg_catalog.regrole,
                                other_role::pg_catalog.regrole, 'MEMBER') THEN
        RAISE EXCEPTION 'REFUSE: runtime role membership crosses trust boundaries: % -> %',
          role_name, other_role;
      END IF;
    END LOOP;
  END LOOP;

  -- Only the migration owner may own the guard. A disabled/replaced trigger
  -- silently defeats the lifecycle checks even if the four functions are safe.
  guard_oid := pg_catalog.to_regprocedure(
    pg_catalog.format('%I.agentvault_model_b_guard_mutation()', target_schema));
  IF guard_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = guard_oid AND p.proowner = table_owner AND NOT p.prosecdef
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = table_oid AND t.tgname = 'agentvault_model_b_mutation_guard'
      AND t.tgfoid = guard_oid AND t.tgenabled IN ('O', 'A') AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'REFUSE: mutation trigger or its owner is untrusted';
  END IF;

  -- The four allowed SECURITY DEFINER procedures must retain the original
  -- owner, fixed pg_catalog search_path, SQL language and exact EXECUTE ACL.
  FOR fn_signature, fn_allowed_role IN
    SELECT x.signature, x.allowed_role
    FROM (VALUES
      ('agentvault_model_b_claim_guarded(text,text,text,text,text,text)', 'av_model_b_coordinator'),
      ('agentvault_model_b_prepare_guarded(text,bytea,text,text,bigint,text,text,text,text,text)', 'av_model_b_coordinator'),
      ('agentvault_model_b_reserve_guarded(text)', 'av_model_b_coordinator'),
      ('agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint)', 'av_model_b_finalizer')
    ) AS x(signature, allowed_role)
  LOOP
    fn_oid := pg_catalog.to_regprocedure(
      pg_catalog.format('%I.%s', target_schema, fn_signature));
    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'REFUSE: expected guarded function is missing: %', fn_signature;
    END IF;
    SELECT p.proowner, p.prosecdef, p.proconfig, p.prolang
      INTO fn_owner, fn_is_definer, fn_settings, fn_language
      FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid;
    IF fn_owner <> table_owner OR fn_is_definer IS DISTINCT FROM TRUE
       OR NOT coalesce('search_path=pg_catalog' = ANY(fn_settings), FALSE)
       OR fn_language <> (SELECT l.oid FROM pg_catalog.pg_language l
                         WHERE l.lanname = 'sql') THEN
      RAISE EXCEPTION 'REFUSE: guarded function has unsafe owner, language or execution context: %',
        fn_signature;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p,
        pg_catalog.aclexplode(coalesce(
          p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
      WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
        AND a.grantee NOT IN (table_owner, fn_allowed_role::pg_catalog.regrole::oid)
    ) THEN
      RAISE EXCEPTION 'REFUSE: guarded function EXECUTE granted to PUBLIC/other role: %',
        fn_signature;
    END IF;
    FOREACH role_name IN ARRAY ARRAY[
      'av_model_b_reader', 'av_model_b_coordinator', 'av_model_b_finalizer'
    ] LOOP
      IF pg_catalog.has_function_privilege(role_name, fn_oid, 'EXECUTE')
          IS DISTINCT FROM (role_name = fn_allowed_role) THEN
        RAISE EXCEPTION 'REFUSE: incorrect effective guarded function EXECUTE: %, %',
          role_name, fn_signature;
      END IF;
    END LOOP;
    approved_oids := pg_catalog.array_append(approved_oids, fn_oid);
  END LOOP;

  -- An unexpected SECURITY DEFINER routine in this payment-only private
  -- schema is an unreviewed escalation path, regardless of its current grants.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = target_schema::pg_catalog.regnamespace
      AND p.prosecdef AND NOT (p.oid = ANY(approved_oids))
  ) THEN
    RAISE EXCEPTION 'REFUSE: unexpected SECURITY DEFINER function in private schema';
  END IF;

  -- Audit effective privileges, not only visible direct GRANT statements.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c,
      pg_catalog.aclexplode(coalesce(
        c.relacl, pg_catalog.acldefault('r', c.relowner))) AS a
    WHERE c.oid = table_oid AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'REFUSE: PUBLIC table privileges remain';
  END IF;
  FOREACH role_name IN ARRAY ARRAY[
    'av_model_b_reader', 'av_model_b_coordinator', 'av_model_b_finalizer'
  ] LOOP
    IF NOT pg_catalog.has_table_privilege(role_name, table_oid, 'SELECT')
       OR pg_catalog.has_table_privilege(role_name, table_oid, 'INSERT')
       OR pg_catalog.has_table_privilege(role_name, table_oid, 'UPDATE')
       OR pg_catalog.has_table_privilege(role_name, table_oid, 'DELETE')
       OR pg_catalog.has_table_privilege(role_name, table_oid, 'TRUNCATE')
       OR pg_catalog.has_table_privilege(role_name, table_oid, 'TRIGGER')
       OR pg_catalog.has_table_privilege(role_name, table_oid, 'REFERENCES') THEN
      RAISE EXCEPTION 'REFUSE: unsafe effective payment table privilege: %', role_name;
    END IF;
    FOR column_name IN
      SELECT attname FROM pg_catalog.pg_attribute
       WHERE attrelid = table_oid AND attnum > 0 AND NOT attisdropped
    LOOP
      IF pg_catalog.has_column_privilege(role_name, table_oid, column_name, 'INSERT')
         OR pg_catalog.has_column_privilege(role_name, table_oid, column_name, 'UPDATE') THEN
        RAISE EXCEPTION 'REFUSE: direct column write privilege: %, %', role_name, column_name;
      END IF;
    END LOOP;
  END LOOP;
END
$av76c10$;
