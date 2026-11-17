-- AgentVault milestone 7.6C.5. Additive, test-only finality evidence.
-- Run AFTER 20261110_model_b_payment_requests.sql in an isolated schema.
-- DO NOT apply to a production database without separate review.
-- No existing claims, signed bytes, or request IDs are modified.
-- NOTE: this migration is intentionally single-apply. Review/backup first.
-- Treat this as one transaction so no partial schema alteration persists.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agentvault_model_b_payment_requests
    WHERE phase IN ('CONFIRMED', 'FAILED')
  ) THEN
    RAISE EXCEPTION 'REFUSE finality migration: legacy terminal rows lack audited finalized slots';
  END IF;
END;
$$;

ALTER TABLE agentvault_model_b_payment_requests
  ADD COLUMN finalized_slot BIGINT,
  ADD COLUMN finality_observed_at TIMESTAMPTZ;

ALTER TABLE agentvault_model_b_payment_requests
  ADD CONSTRAINT agentvault_model_b_finality_consistency CHECK (
    (
      phase IN ('CONFIRMED', 'FAILED')
      AND finalized_slot IS NOT NULL
      AND finalized_slot >= 0
      AND finality_observed_at IS NOT NULL
    ) OR (
      phase NOT IN ('CONFIRMED', 'FAILED')
      AND finalized_slot IS NULL
      AND finality_observed_at IS NULL
    )
  );

-- Replace original guard with one that also locks terminal evidence.
CREATE OR REPLACE FUNCTION agentvault_model_b_guard_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment requests cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.phase <> 'CLAIMED' OR NEW.finalized_slot IS NOT NULL
       OR NEW.finality_observed_at IS NOT NULL THEN
      RAISE EXCEPTION 'payment request must start CLAIMED without finality';
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

  IF OLD.finalized_slot IS NOT NULL OR OLD.finality_observed_at IS NOT NULL THEN
    IF ROW(OLD.finalized_slot, OLD.finality_observed_at)
       IS DISTINCT FROM ROW(NEW.finalized_slot, NEW.finality_observed_at) THEN
      RAISE EXCEPTION 'finality evidence is immutable';
    END IF;
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

  -- PostgreSQL, not the caller, defines the observation timestamp.
  IF NEW.phase IN ('CONFIRMED', 'FAILED') THEN
    IF NEW.finalized_slot IS NULL OR NEW.finalized_slot < 0 THEN
      RAISE EXCEPTION 'invalid finalized payment evidence';
    END IF;
    NEW.finality_observed_at := clock_timestamp();
  ELSE
    IF NEW.finalized_slot IS NOT NULL OR NEW.finality_observed_at IS NOT NULL THEN
      RAISE EXCEPTION 'unfinalized request cannot carry finality evidence';
    END IF;
  END IF;
  NEW.changed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

COMMIT;
