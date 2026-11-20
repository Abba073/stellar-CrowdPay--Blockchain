'use strict';

/**
 * emailService tests — issue #62
 *
 * Verifies that sendEmailSafe swallows SMTP errors so callers can fire-and-forget
 * without risking unhandled promise rejections or process crashes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildEmailService({ transporterImpl } = {}) {
  const defaultTransporter = {
    sendMail: async () => ({ messageId: 'test-msg-id' }),
  };

  // Patch nodemailer so we control the transporter without real SMTP.
  const nodemailerStub = {
    createTransport: () => transporterImpl || defaultTransporter,
  };

  // Ensure the module sees SMTP_HOST so it creates the transporter branch.
  const prevHost = process.env.SMTP_HOST;
  const prevDisabled = process.env.DISABLE_EMAILS;
  process.env.SMTP_HOST = 'smtp.test.local';
  process.env.DISABLE_EMAILS = '';

  const service = proxyquire('./emailService', {
    nodemailer: nodemailerStub,
    '../config/database': { query: async () => ({ rows: [] }) },
  });

  // Restore env so the module cache doesn't bleed between tests.
  process.env.SMTP_HOST = prevHost === undefined ? '' : prevHost;
  if (prevDisabled === undefined) delete process.env.DISABLE_EMAILS;
  else process.env.DISABLE_EMAILS = prevDisabled;

  return service;
}

// ---------------------------------------------------------------------------
// sendEmail — base behaviour
// ---------------------------------------------------------------------------

test('sendEmail resolves when the transporter succeeds', async () => {
  const service = buildEmailService();
  // Should resolve without throwing.
  await assert.doesNotReject(() =>
    service.sendEmail({ to: 'user@example.com', subject: 'Hi', text: 'Hello' })
  );
});

test('sendEmail rejects when the transporter throws', async () => {
  const failingTransporter = {
    sendMail: async () => { throw new Error('SMTP connection refused'); },
  };
  const service = buildEmailService({ transporterImpl: failingTransporter });

  await assert.rejects(
    () => service.sendEmail({ to: 'user@example.com', subject: 'Test', text: 'Body' }),
    /SMTP connection refused/,
    'sendEmail must propagate the underlying SMTP error'
  );
});

// ---------------------------------------------------------------------------
// sendEmailSafe — non-throwing wrapper (issue #62 acceptance criteria)
// ---------------------------------------------------------------------------

test('sendEmailSafe resolves even when the transporter throws', async () => {
  const failingTransporter = {
    sendMail: async () => { throw new Error('SMTP connection refused'); },
  };
  const service = buildEmailService({ transporterImpl: failingTransporter });

  // Must NOT throw — email failure is swallowed after logging.
  await assert.doesNotReject(
    () => service.sendEmailSafe({ to: 'user@example.com', subject: 'Fail', text: 'Body' }),
    'sendEmailSafe must never throw even when the underlying SMTP call fails'
  );
});

test('sendEmailSafe resolves when the transporter succeeds', async () => {
  const service = buildEmailService();
  await assert.doesNotReject(() =>
    service.sendEmailSafe({ to: 'user@example.com', subject: 'OK', text: 'Body' })
  );
});

test('sendEmailSafe does not produce unhandled rejections on repeated SMTP failures', async () => {
  const failingTransporter = {
    sendMail: async () => { throw new Error('Network timeout'); },
  };
  const service = buildEmailService({ transporterImpl: failingTransporter });

  // Simulate the fire-and-forget pattern used across ~7 call sites:
  // none of these should throw or leave an unhandled rejection.
  const calls = Array.from({ length: 5 }, (_, i) =>
    service.sendEmailSafe({ to: `user${i}@example.com`, subject: 'Blast', text: 'Body' })
  );
  await assert.doesNotReject(() => Promise.all(calls));
});

// ---------------------------------------------------------------------------
// DISABLE_EMAILS guard
// ---------------------------------------------------------------------------

test('sendEmail returns early and does NOT call the transporter when DISABLE_EMAILS=true', async () => {
  let called = false;
  const trackingTransporter = {
    sendMail: async () => { called = true; return {}; },
  };

  const prevHost = process.env.SMTP_HOST;
  const prevDisabled = process.env.DISABLE_EMAILS;
  process.env.SMTP_HOST = 'smtp.test.local';
  process.env.DISABLE_EMAILS = 'true';

  const service = proxyquire('./emailService', {
    nodemailer: { createTransport: () => trackingTransporter },
    '../config/database': { query: async () => ({ rows: [] }) },
  });

  process.env.SMTP_HOST = prevHost === undefined ? '' : prevHost;
  if (prevDisabled === undefined) delete process.env.DISABLE_EMAILS;
  else process.env.DISABLE_EMAILS = prevDisabled;

  await service.sendEmail({ to: 'user@example.com', subject: 'Disabled', text: 'Body' });
  assert.equal(called, false, 'transporter.sendMail must not be called when emails are disabled');
});
