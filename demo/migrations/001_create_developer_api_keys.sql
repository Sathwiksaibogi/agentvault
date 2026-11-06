
CREATE TABLE developer_api_keys (
    key_id TEXT PRIMARY KEY
        CHECK (key_id ~ '^[0-9a-f]{24}$'),

    principal_id TEXT NOT NULL
        CHECK (length(trim(principal_id)) > 0),

    token_hash TEXT NOT NULL
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),

    vaults TEXT[] NOT NULL
        CHECK (
            cardinality(vaults) > 0
            AND array_position(vaults, NULL) IS NULL
        ),

    scopes TEXT[] NOT NULL
        CHECK (
            cardinality(scopes) > 0
            AND array_position(scopes, NULL) IS NULL
            AND scopes <@ ARRAY['activity:read']::TEXT[]
        ),

    created_at BIGINT NOT NULL
        CHECK (created_at >= 0),

    expires_at BIGINT
        CHECK (
            expires_at IS NULL
            OR expires_at > created_at
        ),

    revoked_at BIGINT
        CHECK (
            revoked_at IS NULL
            OR revoked_at >= created_at
        )
);

CREATE INDEX idx_developer_api_keys_principal
    ON developer_api_keys (principal_id);

REVOKE ALL ON developer_api_keys FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE (revoked_at)
    ON developer_api_keys
    TO agentvault_app;
