-- Send job state machine; alerts had no column serving as send state.
ALTER TABLE alerts
  ADD COLUMN send_state text NOT NULL DEFAULT 'pending' CHECK (send_state IN ('pending', 'sending', 'sent', 'expired')),
  ADD COLUMN sent_at timestamptz;
-- One delivery per recipient per alert: a re-run can never create a second message row.
ALTER TABLE deliveries ADD CONSTRAINT deliveries_alert_recipient_unique UNIQUE (alert_id, recipient_id);
