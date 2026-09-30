ALTER TABLE establishments
ADD COLUMN business_location_code TEXT;

CREATE UNIQUE INDEX uq_establishment_business_location_per_company
ON establishments(company_id, business_location_code)
WHERE
    is_active = TRUE
    AND business_location_code IS NOT NULL
    AND business_location_code <> '';
