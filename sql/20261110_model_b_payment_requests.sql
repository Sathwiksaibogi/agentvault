-- AgentVault 7.6C.2: inactive payment-coordination table.
-- Run only in an isolated test database until the migration has been reviewed.
-- Production role should have SELECT/INSERT/UPDATE only (never DELETE/TRUNCATE).
-- Does not modify any existing Model A/B file journal.

CREATE TABLE IF NOT EXISTS agentvault_model_b_payment_requests (
    request_id TEXT PRIMARY KEY
        CHECK (request_id ~ '^[a-zA-Z0-9_-]{8,64}$'),
    genesis_hash TEXT NOT NULL,
    program_id TEXT NOT NULL,
    vault TEXT NOT NULL,
    workflow_digest TEXT NOT NULL
        CHECK (workflow_digest ~ '^[0-9a-f]{64}$'),
    payment_digest TEXT NOT NULL
        CHECK (payment_digest ~ '^[0-9a-f]{64}$'),
    phase TEXT NOT NULL DEFAULT 'CLAIMED'
        CHECK (phase IN (
            'CLAIMED', 'PREPARED', 'SUBMISSION_RESERVED',
            'UNRESOLVED', 'CONFIRMED', 'FAILED'
        )),
    signed_tx_bytes BYTEA,
    signed_tx_sha256 TEXT,
    tx_signature TEXT,
    last_valid_block_height BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (
      (
        phase = 'CLAIMED' AND signed_tx_bytes IS NULL
        AND signed_tx_sha256 IS NULL AND tx_signature IS NULL
        AND last_valid_block_height IS NULL
      ) OR (
        phase <> 'CLAIMED' AND signed_tx_bytes IS NOT NULL
        AND length(signed_tx_bytes) > 0
        AND signed_tx_sha256 IS NOT NULL
        AND signed_tx_sha256 ~ '^[0-9a-f]{64}$'
        AND tx_signature IS NOT NULL
        AND last_valid_block_height IS NOT NULL
        AND last_valid_block_height >= 0
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS agentvault_model_b_tx_signature_unique
ON agentvault_model_b_payment_requests(tx_signature)
WHERE tx_signature IS NOT NULL;

-- A trigger makes signed bytes and claim identity immutable, even if an
-- application query accidentally tries to overwrite them.
CREATE OR REPLACE FUNCTION agentvault_model_b_guard_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment requests cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.phase <> 'CLAIMED' THEN
      RAISE EXCEPTION 'payment request must start CLAIMED';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(OLD.request_id, OLD.genesis_hash, OLD.program_id, OLD.vault,
         OLD.workflow_digest, OLD.payment_digest, OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.request_id, NEW.genesis_hash, NEW.program_id, NEW.vault,
         NEW.workflow_digest, NEW.payment_digest, NEW.created_at) THEN
    RAISE EXCEPTION 'payment request identity is immutable';
  END IF;

  IF OLD.signed_tx_bytes IS NOT NULL AND
     ROW(OLD.signed_tx_bytes, OLD.signed_tx_sha256,
         OLD.tx_signature, OLD.last_valid_block_height)
     IS DISTINCT FROM
     ROW(NEW.signed_tx_bytes, NEW.signed_tx_sha256,
         NEW.tx_signature, NEW.last_valid_block_height) THEN
    RAISE EXCEPTION 'signed payment bytes and signature are immutable';
  END IF;

  IF NOT (
       (OLD.phase = 'CLAIMED' AND NEW.phase = 'PREPARED')
    OR (OLD.phase = 'PREPARED' AND NEW.phase = 'SUBMISSION_RESERVED')
    OR (OLD.phase = 'SUBMISSION_RESERVED' AND NEW.phase IN
          ('CONFIRMED', 'FAILED', 'UNRESOLVED'))
    OR (OLD.phase = 'UNRESOLVED' AND NEW.phase IN ('CONFIRMED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'forbidden payment request phase transition: % -> %',
      OLD.phase, NEW.phase;
  END IF;

  NEW.changed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agentvault_model_b_mutation_guard
  ON agentvault_model_b_payment_requests;
CREATE TRIGGER agentvault_model_b_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON agentvault_model_b_payment_requests
FOR EACH ROW EXECUTE FUNCTION agentvault_model_b_guard_mutation();
