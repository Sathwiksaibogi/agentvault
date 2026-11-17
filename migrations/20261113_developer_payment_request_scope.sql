BEGIN;

ALTER TABLE public.developer_api_keys
DROP CONSTRAINT developer_api_keys_scopes_check;

ALTER TABLE public.developer_api_keys
ADD CONSTRAINT developer_api_keys_scopes_check
CHECK (
  cardinality(scopes) > 0
  AND array_position(scopes, NULL::text) IS NULL
  AND scopes <@ ARRAY[
    'activity:read'::text,
    'payments:request'::text
  ]
);

COMMIT;
