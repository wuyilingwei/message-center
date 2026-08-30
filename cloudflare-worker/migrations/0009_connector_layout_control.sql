CREATE TABLE IF NOT EXISTS connector_layout_control (
  connector_id TEXT PRIMARY KEY,
  desired_enabled INTEGER NOT NULL DEFAULT 0 CHECK(desired_enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  desired_reason TEXT NOT NULL DEFAULT 'not_configured',
  desired_updated_at TEXT NOT NULL,
  reported_enabled INTEGER CHECK(reported_enabled IS NULL OR reported_enabled IN (0, 1)),
  reported_revision INTEGER CHECK(reported_revision IS NULL OR reported_revision >= 0),
  reported_reason TEXT,
  reported_at TEXT,
  device_generation INTEGER CHECK(device_generation IS NULL OR device_generation >= 0),
  device_action_id TEXT,
  device_action_revision INTEGER CHECK(device_action_revision IS NULL OR device_action_revision >= 0),
  device_action_enabled INTEGER CHECK(device_action_enabled IS NULL OR device_action_enabled IN (0, 1)),
  CHECK(
    (device_generation IS NULL AND device_action_id IS NULL AND
      device_action_revision IS NULL AND device_action_enabled IS NULL) OR
    (device_generation IS NOT NULL AND device_action_id IS NOT NULL AND
      device_action_revision IS NOT NULL AND device_action_enabled IS NOT NULL)
  ),
  CHECK(device_action_revision IS NULL OR device_action_revision <= revision),
  FOREIGN KEY (connector_id) REFERENCES connector_instances(id)
);
