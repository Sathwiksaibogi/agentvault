-- AgentVault 77D3C1: INACTIVE PostgreSQL foundation for Model A agent discovery.
-- Run as a migration owner with search_path pinned to a DEDICATED PRIVATE schema.
-- Do not grant runtime service credentials access to this table yet.
BEGIN;
DO $$
DECLARE s text := current_schema();
BEGIN
  IF s IS NULL OR s IN ('public', 'pg_catalog', 'information_schema')
     OR s ~ '^pg_' THEN
    RAISE EXCEPTION 'Model A inbox requires a private, explicitly selected schema';
  END IF;
  IF NOT has_schema_privilege(current_user, s, 'CREATE') THEN
    RAISE EXCEPTION 'Migration owner must be able to create in selected schema';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS model_a_agent_inbox (
  network text NOT NULL CHECK (network = 'devnet'),
  vault text NOT NULL,
  request_id text NOT NULL,
  agent_authority text NOT NULL,
  principal_id text NOT NULL,
  created_at_unix bigint NOT NULL CHECK (created_at_unix >= 0),
  expires_at_unix bigint NOT NULL CHECK (expires_at_unix > created_at_unix),
  status text NOT NULL CHECK (status = 'received'),
  record jsonb NOT NULL,
  CONSTRAINT model_a_agent_inbox_key PRIMARY KEY (network, vault, request_id),
  CONSTRAINT model_a_agent_inbox_record_binding CHECK (
    COALESCE(
      jsonb_typeof(record) = 'object'
      AND jsonb_typeof(record -> 'request') = 'object'
      AND record ->> 'version' = '1'
      AND record ->> 'kind' = 'model-a-payment-intent'
      AND record ->> 'status' = status
      AND record ->> 'network' = network
      AND record ->> 'vault' = vault
      AND record ->> 'principalId' = principal_id
      AND record ->> 'createdAtUnix' = created_at_unix::text
      AND record #>> '{request,requestId}' = request_id
      AND record #>> '{request,agentAuthority}' = agent_authority
      AND record #>> '{request,expiresAtUnix}' = expires_at_unix::text,
      false
    )
  )
);

CREATE INDEX IF NOT EXISTS model_a_agent_inbox_discovery_idx
  ON model_a_agent_inbox (
    network, vault, agent_authority, status, created_at_unix, request_id
  ) INCLUDE (expires_at_unix);

REVOKE ALL ON TABLE model_a_agent_inbox FROM PUBLIC;
COMMIT;
