-- AgentVault 77D3C3: INACTIVE, acknowledgment-only Model A inbox receipt.
-- Apply AFTER 77D3C1 and 77D3C2 migrations in a disposable private schema.
-- Receipt NEVER approves, claims, schedules, signs, broadcasts, or pays.
-- DBA must provision NOLOGIN av_model_a_ack before migration.
BEGIN;
DO $guard$
DECLARE
  s text := current_schema();
  owner_name text;
BEGIN
  IF s IS NULL OR s !~ '^[a-z][a-z0-9_]{0,62}$'
     OR s IN ('public', 'information_schema') OR s LIKE 'pg\_%' ESCAPE '\' THEN
    RAISE EXCEPTION 'Explicit private inbox schema required';
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
    RAISE EXCEPTION 'Base inbox must belong to migration owner';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r WHERE r.rolname = 'av_model_a_ack'
      AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
      AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Pre-provision dedicated restricted NOLOGIN ack role';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
     WHERE r.rolname = 'av_model_a_ack'
  ) THEN
    RAISE EXCEPTION 'Acknowledgment role must not inherit other roles';
  END IF;
END
$guard$;

CREATE TABLE model_a_inbox_acks (
  network text NOT NULL CHECK (network = 'devnet'),
  vault text NOT NULL,
  request_id text NOT NULL,
  agent_authority text NOT NULL,
  acknowledged_at_unix bigint NOT NULL CHECK (acknowledged_at_unix >= 0),
  PRIMARY KEY (network, vault, request_id),
  FOREIGN KEY (network, vault, request_id)
    REFERENCES model_a_agent_inbox (network, vault, request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

DO $create$
DECLARE s text := current_schema();
BEGIN
  EXECUTE replace($ddl$
CREATE FUNCTION __SCHEMA__.model_a_inbox_acknowledge(
  p_vault text, p_agent_authority text, p_request_id text, p_now_unix bigint
) RETURNS TABLE(acknowledged_at_unix bigint, duplicate boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE v_ack bigint;
BEGIN
  IF p_now_unix IS NULL OR p_now_unix < 0
     OR p_vault IS NULL OR p_agent_authority IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Invalid acknowledgment input' USING ERRCODE = '22023';
  END IF;
  -- No direct table privileges granted. The function's caller MUST already
  -- be authenticated by the backend with a freshly verified signed agent scope.
  INSERT INTO __SCHEMA__.model_a_inbox_acks
    (network, vault, request_id, agent_authority, acknowledged_at_unix)
  SELECT i.network, i.vault, i.request_id, i.agent_authority, p_now_unix
    FROM __SCHEMA__.model_a_agent_inbox i
   WHERE i.network = 'devnet' AND i.vault = p_vault
     AND i.agent_authority = p_agent_authority AND i.request_id = p_request_id
     AND i.status = 'received'
     AND i.created_at_unix <= p_now_unix
     AND i.expires_at_unix > p_now_unix
  ON CONFLICT (network, vault, request_id) DO NOTHING
  RETURNING model_a_inbox_acks.acknowledged_at_unix INTO v_ack;
  IF FOUND THEN
    RETURN QUERY SELECT v_ack, false;
    RETURN;
  END IF;
  -- A duplicate remains valid only while the underlying request is active.
  -- Separate statement sees a committed concurrent winner at READ COMMITTED.
  SELECT a.acknowledged_at_unix INTO v_ack
    FROM __SCHEMA__.model_a_inbox_acks a
    JOIN __SCHEMA__.model_a_agent_inbox i
      ON i.network = a.network AND i.vault = a.vault
     AND i.request_id = a.request_id
   WHERE a.network = 'devnet' AND a.vault = p_vault
     AND a.request_id = p_request_id AND a.agent_authority = p_agent_authority
     AND i.agent_authority = p_agent_authority
     AND i.status = 'received' AND i.created_at_unix <= p_now_unix
     AND i.expires_at_unix > p_now_unix;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Acknowledgment not available' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY SELECT v_ack, true;
END
$body$;
$ddl$, '__SCHEMA__', quote_ident(s));
END
$create$;

-- Security definer functions have PUBLIC EXECUTE by default unless revoked.
REVOKE ALL ON TABLE model_a_inbox_acks
  FROM PUBLIC, av_model_a_intake, av_model_a_reader, av_model_a_ack;
REVOKE ALL ON FUNCTION model_a_inbox_acknowledge(text, text, text, bigint)
  FROM PUBLIC, av_model_a_intake, av_model_a_reader, av_model_a_ack;
DO $priv$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM av_model_a_ack', s);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO av_model_a_ack', s);
END
$priv$;
GRANT EXECUTE ON FUNCTION model_a_inbox_acknowledge(text, text, text, bigint)
  TO av_model_a_ack;
COMMIT;
