
\set ON_ERROR_STOP on

BEGIN;

-- Confirm the test is running against the intended database.
DO $$
BEGIN
    IF current_database() <> 'agentvault_dev' THEN
        RAISE EXCEPTION 'Wrong test database';
    END IF;
END;
$$;

-- Test as the application role, not the superuser.
SET LOCAL ROLE agentvault_app;

-- Insert a valid credential.
INSERT INTO developer_api_keys (
    key_id,
    principal_id,
    token_hash,
    vaults,
    scopes,
    created_at,
    expires_at,
    revoked_at
)
VALUES (
    'aaaaaaaaaaaaaaaaaaaaaaaa',
    'test_developer',
    repeat('b', 64),
    ARRAY['11111111111111111111111111111111'],
    ARRAY['activity:read'],
    1800000000000,
    NULL,
    NULL
);

-- Verify insertion and metadata.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM developer_api_keys
        WHERE key_id = 'aaaaaaaaaaaaaaaaaaaaaaaa'
          AND principal_id = 'test_developer'
          AND revoked_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Credential insertion failed';
    END IF;
END;
$$;

-- Revoke the credential.
UPDATE developer_api_keys
SET revoked_at = 1800000001000
WHERE key_id = 'aaaaaaaaaaaaaaaaaaaaaaaa'
  AND revoked_at IS NULL;

-- Verify the credential is revoked.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM developer_api_keys
        WHERE key_id = 'aaaaaaaaaaaaaaaaaaaaaaaa'
          AND revoked_at = 1800000001000
    ) THEN
        RAISE EXCEPTION 'Credential revocation failed';
    END IF;
END;
$$;

-- Forbidden operations are tested inside nested exception blocks.
-- PostgreSQL rolls back the failed statement automatically
-- within each PL/pgSQL exception block.

DO $$
BEGIN
    BEGIN
        UPDATE developer_api_keys
        SET revoked_at = NULL
        WHERE key_id = 'aaaaaaaaaaaaaaaaaaaaaaaa';

        RAISE EXCEPTION 'SECURITY_TEST_FAILED: revocation cleared';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE 'SECURITY_TEST_FAILED:%' THEN
            RAISE;
        END IF;
    END;

    BEGIN
        UPDATE developer_api_keys
        SET revoked_at = 1800000002000
        WHERE key_id = 'aaaaaaaaaaaaaaaaaaaaaaaa';

        RAISE EXCEPTION 'SECURITY_TEST_FAILED: revoked key modified';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE 'SECURITY_TEST_FAILED:%' THEN
            RAISE;
        END IF;
    END;

    BEGIN
        DELETE FROM developer_api_keys
        WHERE key_id = 'aaaaaaaaaaaaaaaaaaaaaaaa';

        RAISE EXCEPTION 'SECURITY_TEST_FAILED: DELETE succeeded';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE 'SECURITY_TEST_FAILED:%' THEN
            RAISE;
        END IF;
    END;

    BEGIN
        UPDATE developer_api_keys
        SET token_hash = repeat('c', 64)
        WHERE key_id = 'aaaaaaaaaaaaaaaaaaaaaaaa';

        RAISE EXCEPTION 'SECURITY_TEST_FAILED: verifier modified';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE 'SECURITY_TEST_FAILED:%' THEN
            RAISE;
        END IF;
    END;
END;
$$;

RESET ROLE;

ROLLBACK;
