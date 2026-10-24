-- A failed geocode must still store the alert (as needs_review); verified alerts always have coordinates.
ALTER TABLE alerts ALTER COLUMN lat DROP NOT NULL, ALTER COLUMN lng DROP NOT NULL;
ALTER TABLE alerts ADD CONSTRAINT alerts_verified_has_geo
  CHECK (verification_status <> 'verified' OR (lat IS NOT NULL AND lng IS NOT NULL));
