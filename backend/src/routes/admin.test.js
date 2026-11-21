const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const pool = require('../config/database');
const app = require('../index');

describe('Admin Moderation Features', async () => {
  let client;
  let adminToken;
  let regularUserToken;
  let testUserId;
  let adminUserId;
  let campaignId;

  before(async () => {
    client = await pool.connect();
    
    // Setup: Create admin and regular user
    const adminRes = await pool.query(
      `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted, is_admin)
       VALUES ($1, 'hash', 'Admin User', 'G_ADMIN_PUB', 'enc_admin')
       RETURNING id`,
      ['admin@test.com']
    );
    adminUserId = adminRes.rows[0].id;

    const userRes = await pool.query(
      `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
       VALUES ($1, 'hash', 'Test User', 'G_USER_PUB', 'enc_user')
       RETURNING id`,
      ['user@test.com']
    );
    testUserId = userRes.rows[0].id;

    // Create a test campaign
    const campaignRes = await pool.query(
      `INSERT INTO campaigns (creator_id, title, description, target_amount, asset_type, wallet_public_key, status)
       VALUES ($1, 'Test Campaign', 'Test Description', 1000, 'XLM', 'G_CAMPAIGN_PUB', 'active')
       RETURNING id`,
      [testUserId]
    );
    campaignId = campaignRes.rows[0].id;

    // Create JWT tokens (simplified for testing)
    const jwt = require('jsonwebtoken');
    adminToken = jwt.sign({ userId: adminUserId, is_admin: true }, process.env.JWT_SECRET);
    regularUserToken = jwt.sign({ userId: testUserId, is_admin: false }, process.env.JWT_SECRET);
  });

  after(async () => {
    if (client) {
      client.release();
    }
  });

  describe('Admin Authentication', () => {
    it('non-admin users should receive 403 from admin routes', async () => {
      const res = await fetch('http://localhost:3000/api/admin/campaigns', {
        headers: { Authorization: `Bearer ${regularUserToken}` }
      });
      assert.strictEqual(res.status, 403);
    });

    it('admin users should access admin routes', async () => {
      const res = await fetch('http://localhost:3000/api/admin/stats', {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.strictEqual(res.status, 200);
    });

    it('unauthenticated users should receive 401', async () => {
      const res = await fetch('http://localhost:3000/api/admin/stats');
      assert.strictEqual(res.status, 401);
    });
  });

  describe('Campaign Suspension', () => {
    it('admin can suspend a campaign', async () => {
      const res = await fetch(`http://localhost:3000/api/admin/campaigns/${campaignId}/suspend`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason: 'Policy violation' })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.campaign.status, 'suspended');
    });

    it('suspended campaigns are hidden from public listing', async () => {
      const res = await fetch('http://localhost:3000/api/campaigns');
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      const suspended = data.campaigns.find(c => c.status === 'suspended');
      assert.strictEqual(suspended, undefined);
    });

    it('suspended campaigns show notice when viewed directly', async () => {
      const res = await fetch(`http://localhost:3000/api/campaigns/${campaignId}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, 'suspended');
      assert.match(data.suspended_notice, /suspended/i);
    });

    it('contributions cannot be made to suspended campaigns', async () => {
      const res = await fetch('http://localhost:3000/api/contributions/prepare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${regularUserToken}`
        },
        body: JSON.stringify({
          campaignId: campaignId,
          senderPublicKey: 'G_USER_PUB',
          amount: '100',
          asset: 'XLM'
        })
      });
      assert.strictEqual(res.status, 400);
    });

    it('admin can restore a suspended campaign', async () => {
      const res = await fetch(`http://localhost:3000/api/admin/campaigns/${campaignId}/restore`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.campaign.status, 'active');
    });
  });

  describe('Campaign Deletion', () => {
    it('admin can soft-delete a campaign', async () => {
      const res = await fetch(`http://localhost:3000/api/admin/campaigns/${campaignId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason: 'Fraudulent campaign' })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.campaign.deleted_at);
    });

    it('deleted campaigns return 404', async () => {
      const res = await fetch(`http://localhost:3000/api/campaigns/${campaignId}`);
      assert.strictEqual(res.status, 404);
    });
  });

  describe('User Management', () => {
    let banTestUserId;

    before(async () => {
      const res = await pool.query(
        `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
         VALUES ($1, 'hash', 'Ban Test User', 'G_BAN_TEST_PUB', 'enc_ban_test')
         RETURNING id`,
        ['bantest@test.com']
      );
      banTestUserId = res.rows[0].id;
    });

    it('admin can ban a user', async () => {
      const res = await fetch(`http://localhost:3000/api/admin/users/${banTestUserId}/ban`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason: 'Abusive behavior' })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.user.is_banned, true);
    });

    it('admin can unban a user', async () => {
      const res = await fetch(`http://localhost:3000/api/admin/users/${banTestUserId}/unban`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.user.is_banned, false);
    });

    it('banning requires a reason', async () => {
      const res = await fetch(`http://localhost:3000/api/admin/users/${banTestUserId}/ban`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason: '' })
      });
      assert.strictEqual(res.status, 400);
    });
  });

  describe('Audit Logging', () => {
    it('admin actions are logged in audit table', async () => {
      const res = await fetch('http://localhost:3000/api/admin/audit-log', {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.actions));
      assert.ok(data.actions.length > 0);
    });

    it('audit log contains action type, target, and admin info', async () => {
      const res = await fetch('http://localhost:3000/api/admin/audit-log', {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      const data = await res.json();
      const action = data.actions[0];
      assert.ok(action.id);
      assert.ok(action.admin_user_id);
      assert.ok(action.action_type);
      assert.ok(action.target_type);
      assert.ok(action.target_id);
      assert.ok(action.created_at);
    });
  });

  describe('Admin Stats', () => {
    it('admin stats include moderation metrics', async () => {
      const res = await fetch('http://localhost:3000/api/admin/stats', {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(typeof data.total_users === 'number');
      assert.ok(typeof data.banned_users === 'number');
      assert.ok(typeof data.deleted_campaigns === 'number');
      assert.ok(Array.isArray(data.campaign_status));
    });
  });

  describe('Deleted Campaign Management', () => {
    it('admin can list deleted campaigns', async () => {
      const res = await fetch('http://localhost:3000/api/admin/campaigns/deleted', {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data));
    });

    it('admin can restore a soft-deleted campaign', async () => {
      // First soft-delete the campaign
      await fetch(`http://localhost:3000/api/admin/campaigns/${campaignId}`, {
        method: 'DELETE',
        headers: { 
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason: 'Test deletion' })
      });

      // Restore the campaign
      const res = await fetch(`http://localhost:3000/api/admin/campaigns/${campaignId}/restore`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.message, 'Campaign restored from deleted');
      assert.ok(data.campaign.deleted_at === null);
      assert.strictEqual(data.campaign.status, 'active');
    });

    it('restore endpoint handles non-existent campaign', async () => {
      const fakeId = 999999;
      const res = await fetch(`http://localhost:3000/api/admin/campaigns/${fakeId}/restore`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(res.status, 404);
    });
  });
});
