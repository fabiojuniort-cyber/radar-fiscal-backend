-- NEWS-02 / 027
-- Register the Receita Federal official news source as configuration-as-code.
-- It intentionally starts paused. Activation happens only after a production
-- connectivity/parser smoke proves the real gov.br surface is compatible.

INSERT INTO sources (
    code,
    name,
    jurisdiction_level,
    agency,
    base_url,
    connector_key,
    connector_config,
    schedule_cron,
    schedule_timezone,
    max_attempts,
    is_active,
    content_kind
)
VALUES (
    'rfb-news',
    'Receita Federal — Notícias',
    'FEDERAL',
    'RFB',
    'https://www.gov.br/receitafederal/pt-br/assuntos/noticias',
    'rfb-news',
    '{"listingUrl":"https://www.gov.br/receitafederal/pt-br/assuntos/noticias/ultimas-noticias","filtering":"DETERMINISTIC_TAX_RELEVANCE_V1","maxArticlesPerRun":30}'::jsonb,
    '0 8,12,16,20 * * *',
    'America/Sao_Paulo',
    3,
    FALSE,
    'NEWS'
)
ON CONFLICT (code)
DO UPDATE SET
    name = EXCLUDED.name,
    jurisdiction_level = EXCLUDED.jurisdiction_level,
    agency = EXCLUDED.agency,
    base_url = EXCLUDED.base_url,
    connector_key = EXCLUDED.connector_key,
    connector_config = EXCLUDED.connector_config,
    schedule_cron = EXCLUDED.schedule_cron,
    schedule_timezone = EXCLUDED.schedule_timezone,
    max_attempts = EXCLUDED.max_attempts,
    content_kind = EXCLUDED.content_kind,
    updated_at = now();
