-- AgentVault 77D3C2: INACTIVE Model A private inbox role boundary.
-- Apply only AFTER 20261113_model_a_agent_inbox.sql in the SAME private schema.
-- The migration owner must own the schema and the inbox table.
-- DBA must pre-provision NOLOGIN roles av_model_a_intake and av_model_a_reader.
-- No API/runtime cutover is performed.
BEGIN;
DO $bootstrap$
DECLARE
  s text := current_schema();
  owner_name text;
  role_name text;
BEGIN
  IF s IS NULL OR s !~ '^[a-z][a-z0-9_]{0,62}$'
     OR s IN ('public', 'information_schema') OR s LIKE 'pg\_%' ESCAPE '\' THEN
    RAISE EXCEPTION 'Require explicitly selected private inbox schema';
  END IF;
  SELECT pg_get_userbyid(n.nspowner) INTO owner_name
    FROM pg_namespace n WHERE n.nspname = s;
  IF owner_name IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'Schema must belong to migration owner';
  END IF;
  SELECT pg_get_userbyid(c.relowner) INTO owner_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = s AND c.relname = 'model_a_agent_inbox' AND c.relkind = 'r';
  IF owner_name IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'Inbox table must belong to migration owner';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['av_model_a_intake','av_model_a_reader'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname = role_name
        AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
        AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls
    ) THEN
      RAISE EXCEPTION 'Dedicated NOLOGIN inbox roles must be provisioned safely';
    END IF;
    -- Runtime roles must not inherit unrelated privileges, including owner rights.
    IF EXISTS (
      SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
       WHERE r.rolname = role_name
    ) THEN
      RAISE EXCEPTION 'Inbox runtime roles cannot be members of any other role';
    END IF;
  END LOOP;
  -- Replace only __SCHEMA__ placeholders with the vetted, quoted schema.
  EXECUTE replace($ddl$
CREATE OR REPLACE FUNCTION __SCHEMA__.model_a_inbox_submit(p_record jsonb)
RETURNS TABLE(saved_record jsonb, duplicate boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_saved jsonb;
BEGIN
  IF jsonb_typeof(p_record) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid request record' USING ERRCODE = '22023';
  END IF;
  INSERT INTO __SCHEMA__.model_a_agent_inbox
    (network, vault, request_id, agent_authority, principal_id,
     created_at_unix, expires_at_unix, status, record)
  VALUES
    (p_record->>'network', p_record->>'vault',
     p_record#>>'{request,requestId}',
     p_record#>>'{request,agentAuthority}', p_record->>'principalId',
     (p_record->>'createdAtUnix')::bigint,
     (p_record#>>'{request,expiresAtUnix}')::bigint,
     p_record->>'status', p_record)
  ON CONFLICT (network, vault, request_id) DO NOTHING
  RETURNING record INTO v_saved;
  IF FOUND THEN
    RETURN QUERY SELECT v_saved, false;
    RETURN;
  END IF;
  -- Second command gets a new READ COMMITTED snapshot after a conflicting
  -- insert has committed. Different payloads for one key fail closed.
  SELECT i.record INTO v_saved FROM __SCHEMA__.model_a_agent_inbox AS i
   WHERE i.network = p_record->>'network'
     AND i.vault = p_record->>'vault'
     AND i.request_id = p_record#>>'{request,requestId}';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conflicting request needs reconciliation'
      USING ERRCODE = '40001';
  END IF;
  -- Match 77D3C1 semantics: same principal and canonical payload are
  -- idempotent even when a retry arrives at a later server timestamp.
  IF v_saved->>'principalId' IS DISTINCT FROM p_record->>'principalId'
     OR v_saved->'request' IS DISTINCT FROM p_record->'request' THEN
    RAISE EXCEPTION 'Request ID conflict' USING ERRCODE = '23505';
  END IF;
  RETURN QUERY SELECT v_saved, true;
END;
$body$;
$ddl$, '__SCHEMA__', quote_ident(s));
  EXECUTE replace($ddl$
CREATE OR REPLACE FUNCTION __SCHEMA__.model_a_inbox_get(
  p_vault text, p_principal_id text, p_request_id text
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
  SELECT i.record FROM __SCHEMA__.model_a_agent_inbox AS i
   WHERE i.network = 'devnet' AND i.vault = p_vault
     AND i.principal_id = p_principal_id AND i.request_id = p_request_id
$body$;
$ddl$, '__SCHEMA__', quote_ident(s));
  EXECUTE replace($ddl$
CREATE OR REPLACE FUNCTION __SCHEMA__.model_a_inbox_discover(
  p_vault text, p_agent_authority text, p_now_unix bigint
) RETURNS TABLE(record jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
  SELECT i.record FROM __SCHEMA__.model_a_agent_inbox AS i
   WHERE i.network = 'devnet' AND i.vault = p_vault
     AND i.agent_authority = p_agent_authority
     AND i.status = 'received' AND i.expires_at_unix > p_now_unix
   ORDER BY i.created_at_unix, i.request_id
   LIMIT 26
$body$;
$ddl$, '__SCHEMA__', quote_ident(s));
END
$bootstrap$;
-- Security definer functions default to PUBLIC execute: explicitly revoke.
REVOKE ALL ON TABLE model_a_agent_inbox FROM PUBLIC, av_model_a_intake, av_model_a_reader;
DO $priv$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC, av_model_a_intake, av_model_a_reader', s);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO av_model_a_intake, av_model_a_reader', s);
END
$priv$;
REVOKE ALL ON FUNCTION model_a_inbox_submit(jsonb) FROM PUBLIC, av_model_a_intake, av_model_a_reader;
REVOKE ALL ON FUNCTION model_a_inbox_get(text, text, text) FROM PUBLIC, av_model_a_intake, av_model_a_reader;
REVOKE ALL ON FUNCTION model_a_inbox_discover(text, text, bigint) FROM PUBLIC, av_model_a_intake, av_model_a_reader;
GRANT EXECUTE ON FUNCTION model_a_inbox_submit(jsonb) TO av_model_a_intake;
GRANT EXECUTE ON FUNCTION model_a_inbox_get(text, text, text) TO av_model_a_intake;
GRANT EXECUTE ON FUNCTION model_a_inbox_discover(text, text, bigint) TO av_model_a_reader;
-- This is not authorization of an agent: the backend must authenticate and
-- verify the signed (vault, authority) scope before invoking discovery.
COMMIT;
