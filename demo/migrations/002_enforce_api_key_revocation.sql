
-- Enforce immutable API-key credentials and one-way revocation.

CREATE OR REPLACE FUNCTION enforce_developer_api_key_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Once revoked, a credential can never be reactivated
    -- or assigned a different revocation timestamp.
    IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION
            'Revoked API key cannot be modified';
    END IF;

    -- The only permitted update is setting revoked_at.
    IF NEW.key_id IS DISTINCT FROM OLD.key_id
       OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
       OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.vaults IS DISTINCT FROM OLD.vaults
       OR NEW.scopes IS DISTINCT FROM OLD.scopes
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    THEN
        RAISE EXCEPTION
            'API key credential fields are immutable';
    END IF;

    -- An active credential cannot be updated without
    -- transitioning to a revoked state.
    IF NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION
            'API key update must revoke the credential';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_developer_api_key_revocation
BEFORE UPDATE ON developer_api_keys
FOR EACH ROW
EXECUTE FUNCTION enforce_developer_api_key_revocation();
