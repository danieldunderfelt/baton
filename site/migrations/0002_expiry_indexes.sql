-- Expiry sweeps and the pending-device count scan by expires_at.
CREATE INDEX device_codes_expires ON device_codes(expires_at);
CREATE INDEX sessions_expires ON sessions(expires_at);
