-- AgentVault 7.6D.6: ONE-TIME, LOCAL TEST-DATABASE-ONLY LOGIN bootstrap.
-- Run with sudo -u postgres psql -d agentvault_test_76c3, after the NOLOGIN
-- capability roles exist. NEVER run in production or a shared database.
-- Passwords are NOT accepted or persisted by this SQL file. Use psql's
-- interactive \password for each login after successful provisioning.
-- PostgreSQL roles are cluster-global: these names are TEST-ONLY.
BEGIN;
DO $av76d6_test_logins$
DECLARE
  target_db text := pg_catalog.current_database();
  role_names text[] := ARRAY[
    'av76d6_reader_test',
    'av76d6_coordinator_test',
    'av76d6_finalizer_test'
  ];
  capability_names text[] := ARRAY[
    'av_model_b_reader',
    'av_model_b_coordinator',
    'av_model_b_finalizer'
  ];
  i integer;
BEGIN
  IF target_db !~ '^agentvault_test[a-zA-Z0-9_]*$' THEN
    RAISE EXCEPTION 'REFUSE: Model B test login provisioning requires agentvault_test*';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = session_user AND rolsuper
  ) THEN
    RAISE EXCEPTION 'REFUSE: test login provisioning requires a DBA superuser';
  END IF;
  FOR i IN 1..3 LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r
       WHERE r.rolname = capability_names[i] AND NOT (
         r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
         OR r.rolreplication OR r.rolbypassrls
       )
    ) THEN
      RAISE EXCEPTION 'REFUSE: missing or privileged NOLOGIN capability role: %', capability_names[i];
    END IF;
    -- Fail on a collision rather than silently resetting another login's
    -- password, flags, membership, or existing privileges.
    IF pg_catalog.to_regrole(role_names[i]) IS NOT NULL THEN
      RAISE EXCEPTION 'REFUSE: test login already exists: %. Review manually', role_names[i];
    END IF;
  END LOOP;

  -- PostgreSQL ordinarily gives TEMPORARY to PUBLIC. The existing Model B
  -- runtime preflight requires it to be denied for EVERY service login.
  -- Revoking from PUBLIC is safe ONLY in this dedicated local test database.
  EXECUTE pg_catalog.format(
    'REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', target_db);

  FOR i IN 1..3 LOOP
    EXECUTE pg_catalog.format(
      'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL',
      role_names[i]
    );
    EXECUTE pg_catalog.format(
      'GRANT %I TO %I', capability_names[i], role_names[i]
    );
    EXECUTE pg_catalog.format(
      'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM %I',
      target_db, role_names[i]
    );
  END LOOP;
END;
$av76d6_test_logins$;
COMMIT;
