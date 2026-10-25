-- Result of the Tavily opening-hours check at posting time; only 'conflict' holds an alert for review.
ALTER TABLE alerts
  ADD COLUMN hours_check text NOT NULL DEFAULT 'unconfirmed' CHECK (hours_check IN ('confirmed', 'unconfirmed', 'conflict'));
