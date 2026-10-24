CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text NOT NULL,
  contact text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'suspended')),
  verified_at timestamptz,
  tavily_result jsonb,
  tavily_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid REFERENCES providers(id),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'staff' CHECK (role IN ('staff', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'admin') = (provider_id IS NULL))
);

CREATE TABLE recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone bytea NOT NULL,
  phone_hash text NOT NULL UNIQUE,
  channel text NOT NULL CHECK (channel IN ('sms', 'voice')),
  language text NOT NULL DEFAULT 'en',
  zip text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  enrolled_by_provider_id uuid NOT NULL REFERENCES providers(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES recipients(id),
  provider_id uuid NOT NULL REFERENCES providers(id),
  method text NOT NULL CHECK (method IN ('verbal', 'written')),
  consent_text_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- Append-only: no DELETE, and the only permitted UPDATE sets revoked_at.
CREATE FUNCTION consents_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consents is append-only: DELETE not allowed';
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at') THEN
    RAISE EXCEPTION 'consents is append-only: only revoked_at may be updated';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'consents is append-only: revoked_at cannot be changed once set';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER consents_append_only
  BEFORE UPDATE OR DELETE ON consents
  FOR EACH ROW EXECUTE FUNCTION consents_append_only();

CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id),
  service_type text NOT NULL CHECK (service_type IN ('food', 'shelter')),
  address text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  message text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  capacity_cap integer NOT NULL CHECK (capacity_cap > 0),
  urgent boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'needs_review'
    CHECK (verification_status IN ('verified', 'needs_review', 'rejected')),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX alerts_provider_idempotency ON alerts (provider_id, idempotency_key);

CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES alerts(id),
  recipient_id uuid NOT NULL REFERENCES recipients(id),
  vonage_id text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'failed', 'stopped')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_recipient_created ON deliveries (recipient_id, created_at);
CREATE INDEX deliveries_vonage_id ON deliveries (vonage_id);
