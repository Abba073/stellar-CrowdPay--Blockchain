-- Supports keyset pagination of GET /api/admin/audit-log (created_at DESC, id DESC).
CREATE INDEX IF NOT EXISTS admin_actions_created_at_id_idx
  ON admin_actions (created_at DESC, id DESC);
