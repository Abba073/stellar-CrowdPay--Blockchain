-- Seed data for local development demos.
-- Login credentials:
--   alice@example.com / password123
--   bola@example.com / creator123
--   admin@example.com / admin123
--
-- Seeded users are UI-only demo accounts: they are stored as non-custodial ('freighter')
-- wallets with a NULL wallet_secret_encrypted, so no raw or fake secret material is ever
-- written. Use the register flow for fully functional custodial wallets tied to the active
-- encryption provider.

-- Insert mock users
INSERT INTO users (id, email, password_hash, name, wallet_public_key, wallet_secret_encrypted, wallet_type, role, is_admin)
VALUES
  (
    '00000000-0000-0000-0000-000000000001',
    'alice@example.com',
    '$2a$10$DYk4gRzRYFWDKHrrhNGDDu0KeggnjTpaDAIG7aHYtGR58aalFs0aK',
    'Alice Okafor',
    'GBFQZXA6Q4M7BMSNL6Q5M6P47TQIJM47KQKAR5R6XWQ7QX4PX5A7K5TJ',
    NULL,
    'freighter',
    'contributor',
    FALSE
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    'bola@example.com',
    '$2a$10$g2uWQBvPXQWUD/q2xG5/IOk1h3R.ss8iV5vH7nPU5o7Rf0LPNK.X2',
    'Bola Adeyemi',
    'GC3FJ5M7SXXGVC7YZB5RZUGQ4VOVZL7O2TGTQBS5A7VJ6E4SL4P5NH4G',
    NULL,
    'freighter',
    'creator',
    FALSE
  ),
  (
    '00000000-0000-0000-0000-000000000003',
    'admin@example.com',
    '$2a$10$1ll7LPNKN1xfnGQXUipCJe3kGwnZXHCvO3PlZusyaVPf7g8t4E/u6',
    'CrowdPay Admin',
    'GAVS7U42Q4V6KN3PJ7Q7S5FA2LMQ7EJ34O6Y3X6JYB4N4XJXPNPS7JH2',
    NULL,
    'freighter',
    'admin',
    TRUE
  )
ON CONFLICT (email) DO UPDATE
SET
  password_hash = EXCLUDED.password_hash,
  name = EXCLUDED.name,
  wallet_secret_encrypted = EXCLUDED.wallet_secret_encrypted,
  wallet_type = EXCLUDED.wallet_type,
  role = EXCLUDED.role,
  is_admin = EXCLUDED.is_admin;

-- Insert mock campaigns
INSERT INTO campaigns (id, creator_id, title, description, target_amount, raised_amount, asset_type, wallet_public_key, status, deadline)
VALUES
  (
    '11111111-1111-1111-1111-111111111111',
    '00000000-0000-0000-0000-000000000002',
    'Lagos Solar Study Hub',
    'Help us install solar power, internet, and evening study lighting for a neighborhood learning hub in Yaba.',
    8500.0000000,
    3125.5000000,
    'USDC',
    'GDDT53Q2XW4UXFK2JX7GQW7OH7MZBLU6SOO6OP4N3T6QY57K3WKN2X2L',
    'active',
    '2026-07-15'
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    '00000000-0000-0000-0000-000000000002',
    'Community Cold Storage for Farmers',
    'A shared cold-room project that reduces produce spoilage and helps local growers sell at better prices.',
    12000.0000000,
    12000.0000000,
    'USDC',
    'GBW6WQ3D2R7AOB2T6SXY5IKT2E3FKE3LHLRPF3N3VQGJHRKAHWJZXWQJ',
    'funded',
    '2026-05-30'
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    '00000000-0000-0000-0000-000000000002',
    'Women in Hardware Microgrant',
    'Funding prototype kits, mentorship, and demo-day travel stipends for early-stage hardware builders.',
    4000.0000000,
    1850.2500000,
    'XLM',
    'GATLEKJ6A4N5LG3JXG6JQWJPO2V7DNU7C43E2C7ERKJPFK5MCR7MVEQ6',
    'active',
    '2026-08-20'
  ),
  (
    '44444444-4444-4444-4444-444444444444',
    '00000000-0000-0000-0000-000000000002',
    'Clinic Water Upgrade',
    'Replace unsafe water storage and install solar pumping for a rural primary healthcare clinic.',
    6000.0000000,
    6000.0000000,
    'USDC',
    'GDW4P5M7H2QQFXPZV2WCKWAZ5FQY5N7IKB3Y7N4OFU7QJDSO46LQNG7O',
    'in_progress',
    '2026-04-10'
  )
ON CONFLICT (id) DO UPDATE
SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  target_amount = EXCLUDED.target_amount,
  raised_amount = EXCLUDED.raised_amount,
  asset_type = EXCLUDED.asset_type,
  status = EXCLUDED.status,
  deadline = EXCLUDED.deadline;

-- Insert mock campaign updates
INSERT INTO campaign_updates (id, campaign_id, author_id, title, body, created_at)
VALUES
  (
    '55555555-5555-5555-5555-555555555551',
    '11111111-1111-1111-1111-111111111111',
    '00000000-0000-0000-0000-000000000002',
    'Site secured',
    'We signed the space agreement and completed the first round of electrical inspections.',
    NOW() - INTERVAL '6 days'
  ),
  (
    '55555555-5555-5555-5555-555555555552',
    '33333333-3333-3333-3333-333333333333',
    '00000000-0000-0000-0000-000000000002',
    'Mentor lineup confirmed',
    'Three engineers and one manufacturing advisor have confirmed support for the first cohort.',
    NOW() - INTERVAL '2 days'
  )
ON CONFLICT (id) DO NOTHING;

-- Insert mock milestones
INSERT INTO milestones (id, campaign_id, title, description, release_percentage, sort_order, status, evidence_url, destination_key, review_note, created_at, completed_at, approved_at, released_at)
VALUES
  (
    '66666666-6666-6666-6666-666666666661',
    '44444444-4444-4444-4444-444444444444',
    'Pump procurement',
    'Order and deliver the replacement pump and storage tanks.',
    40.0000,
    0,
    'released',
    'https://example.com/evidence/pump-procurement',
    'GDNM4LFM3QFK4KIOCL3VY7WQCMVAM5V7AKBCW7QZ4O5YLTY7HPK3RNUX',
    'Released after invoice and delivery confirmation.',
    NOW() - INTERVAL '20 days',
    NOW() - INTERVAL '14 days',
    NOW() - INTERVAL '12 days',
    NOW() - INTERVAL '12 days'
  ),
  (
    '66666666-6666-6666-6666-666666666662',
    '44444444-4444-4444-4444-444444444444',
    'Solar controller install',
    'Complete wiring, controller installation, and functional load testing.',
    35.0000,
    1,
    'approved',
    'https://example.com/evidence/controller-install',
    'GDNM4LFM3QFK4KIOCL3VY7WQCMVAM5V7AKBCW7QZ4O5YLTY7HPK3RNUX',
    'Awaiting release batch.',
    NOW() - INTERVAL '20 days',
    NOW() - INTERVAL '4 days',
    NOW() - INTERVAL '2 days',
    NULL
  ),
  (
    '66666666-6666-6666-6666-666666666663',
    '44444444-4444-4444-4444-444444444444',
    'Water quality verification',
    'Submit independent water testing results and handover signoff from clinic staff.',
    25.0000,
    2,
    'pending',
    NULL,
    NULL,
    NULL,
    NOW() - INTERVAL '20 days',
    NULL,
    NULL,
    NULL
  )
ON CONFLICT (id) DO NOTHING;

-- Insert mock contributions
INSERT INTO contributions (id, campaign_id, sender_public_key, amount, asset, payment_type, source_amount, source_asset, conversion_rate, path, tx_hash, created_at)
VALUES
  (
    '77777777-7777-7777-7777-777777777771',
    '11111111-1111-1111-1111-111111111111',
    'GBFQZXA6Q4M7BMSNL6Q5M6P47TQIJM47KQKAR5R6XWQ7QX4PX5A7K5TJ',
    250.0000000,
    'USDC',
    'payment',
    NULL,
    NULL,
    NULL,
    NULL,
    'tx-mock-solar-001',
    NOW() - INTERVAL '10 days'
  ),
  (
    '77777777-7777-7777-7777-777777777772',
    '11111111-1111-1111-1111-111111111111',
    'GDV2QIRNNMOLY2V2UQHSK2SZX2ZWEAX43V57Y6Y6B6NQ6XK2D54L5HXM',
    875.5000000,
    'USDC',
    'path_payment_strict_receive',
    910.1200000,
    'XLM',
    0.9619610,
    '["AQUA"]'::jsonb,
    'tx-mock-solar-002',
    NOW() - INTERVAL '8 days'
  ),
  (
    '77777777-7777-7777-7777-777777777773',
    '22222222-2222-2222-2222-222222222222',
    'GBFQZXA6Q4M7BMSNL6Q5M6P47TQIJM47KQKAR5R6XWQ7QX4PX5A7K5TJ',
    2000.0000000,
    'USDC',
    'payment',
    NULL,
    NULL,
    NULL,
    NULL,
    'tx-mock-cold-001',
    NOW() - INTERVAL '18 days'
  ),
  (
    '77777777-7777-7777-7777-777777777774',
    '33333333-3333-3333-3333-333333333333',
    'GC3FJ5M7SXXGVC7YZB5RZUGQ4VOVZL7O2TGTQBS5A7VJ6E4SL4P5NH4G',
    350.2500000,
    'XLM',
    'payment',
    NULL,
    NULL,
    NULL,
    NULL,
    'tx-mock-hardware-001',
    NOW() - INTERVAL '5 days'
  )
ON CONFLICT (id) DO NOTHING;
