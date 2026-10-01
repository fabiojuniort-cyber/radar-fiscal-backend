-- NCM-03 / 028
-- Tracks deterministic NCM enrichment for publication versions, including
-- successful scans with zero matches. This is derived/rebuildable data;
-- publication_ncm_mentions remains the append-only evidence table.

CREATE TABLE publication_ncm_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    publication_version_id UUID NOT NULL
        REFERENCES publication_versions(id)
        ON DELETE CASCADE,
    detector_key TEXT NOT NULL
        CHECK (btrim(detector_key) <> ''),
    detector_version TEXT NOT NULL
        CHECK (btrim(detector_version) <> ''),
    status TEXT NOT NULL
        CHECK (status IN ('SUCCESS', 'FAILED')),
    source_field TEXT NOT NULL
        CHECK (
            source_field IN (
                'CONTENT_TEXT',
                'RELEVANT_EXCERPT',
                'NONE'
            )
        ),
    candidate_count INTEGER NOT NULL DEFAULT 0
        CHECK (candidate_count >= 0),
    match_count INTEGER NOT NULL DEFAULT 0
        CHECK (match_count >= 0 AND match_count <= candidate_count),
    error_message TEXT,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_publication_ncm_scan_detector
        UNIQUE (
            publication_version_id,
            detector_key,
            detector_version
        ),
    CONSTRAINT chk_publication_ncm_scan_error
        CHECK (
            (status = 'SUCCESS' AND error_message IS NULL)
            OR status = 'FAILED'
        )
);

CREATE INDEX ix_publication_ncm_scans_pending_lookup
ON publication_ncm_scans(
    detector_key,
    detector_version,
    status,
    scanned_at
);

CREATE TRIGGER trg_publication_ncm_scans_updated_at
BEFORE UPDATE ON publication_ncm_scans
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

REVOKE ALL ON publication_ncm_scans
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON publication_ncm_scans
TO radar_worker;
