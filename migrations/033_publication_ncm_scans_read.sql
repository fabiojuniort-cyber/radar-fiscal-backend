-- TAX-11 / 033
-- NCM detector 1.1.0 reads only the wording in force of an act. Mentions stay
-- append-only: readers skip those of a detector version superseded by a newer
-- successful scan of the same publication version, so they need to read the
-- scan ledger.

GRANT SELECT ON publication_ncm_scans
TO radar_app, radar_taxonomy_curator;
