-- Settings > Network (services/networkSettings.ts): app-wide and local only (not synced, no capture triggers, not exported
-- or versioned). SSL verification and the proxy live in app_settings ('network.verifySsl', 'network.proxy' as JSON without
-- the password); secrets (proxy password, client-certificate passphrases) only in the OS keychain.

-- Extra trusted CA certificates: the certificate itself (public), one row per certificate of the file it came from.
CREATE TABLE network_ca_certs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  pem         TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  added_at    INTEGER NOT NULL
);

-- Client certificates per host (and optional port): paths of the files the user chose (read when a request needs them, so
-- the private key stays where the user keeps it), either a PEM certificate + key or one PFX / PKCS#12 file.
CREATE TABLE network_client_certs (
  id             TEXT PRIMARY KEY,
  host           TEXT NOT NULL,
  port           INTEGER,
  crt_path       TEXT,
  key_path       TEXT,
  pfx_path       TEXT,
  has_passphrase INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  CHECK ((pfx_path IS NOT NULL AND crt_path IS NULL AND key_path IS NULL) OR (pfx_path IS NULL AND crt_path IS NOT NULL AND key_path IS NOT NULL))
);
