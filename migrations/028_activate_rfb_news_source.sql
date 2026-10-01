-- NEWS-03 / 028
-- The live gov.br surface was validated from Railway before this activation.
-- Activate only the expected NEWS source/connector pair.

UPDATE sources
SET
    is_active = TRUE,
    updated_at = now()
WHERE code = 'rfb-news'
  AND connector_key = 'rfb-news'
  AND content_kind = 'NEWS';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM sources
        WHERE code = 'rfb-news'
          AND connector_key = 'rfb-news'
          AND content_kind = 'NEWS'
          AND is_active = TRUE
    ) THEN
        RAISE EXCEPTION 'rfb-news source was not activated with the expected contract';
    END IF;
END $$;
