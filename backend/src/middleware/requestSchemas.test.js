const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const schemas = require('./requestSchemas');

const ID = '3f2b8c1e-1d2a-4b3c-9d4e-5f6a7b8c9d0e';
const ID2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/** Mounts one schema in front of a handler that echoes the validated body. */
function app(method, path, chain, validate = schemas.validateRequestUnprocessable) {
  const a = express();
  a.use(express.json());
  a[method](path, chain, validate, (req, res) => res.json({ ok: true, body: req.body }));
  return a;
}

const disputes = app('post', '/campaigns/:id/disputes', schemas.disputeCreateValidation);

test('dispute create: accepts a valid body and strips HTML from the description', async () => {
  const res = await request(disputes)
    .post(`/campaigns/${ID}/disputes`)
    .send({ reason: 'non_delivery', description: '  <img src=x onerror=alert(1)>Never shipped  ', evidence_url: 'https://ex.com/a.png' });
  assert.equal(res.status, 200);
  assert.equal(res.body.body.description, 'Never shipped');
});

test('dispute create: rejects bad reasons, wrong types, oversized text, javascript: URLs and bad ids with 422', async () => {
  const cases = [
    [ID, { reason: 'because', description: 'x' }, /reason must be one of/],
    [ID, { reason: ['non_delivery'], description: 'x' }, /reason must be a string/],
    [ID, { reason: 'other', description: ['a', 'b'] }, /description must be a string/],
    [ID, { reason: 'other', description: '   ' }, /description is required/],
    [ID, { reason: 'other', description: 'x'.repeat(5001) }, /at most 5000/],
    [ID, { reason: 'other', description: 'x', evidence_url: 'javascript:alert(1)' }, /http\(s\) URL/],
    [ID, { reason: 'other', description: 'x', evidence_url: { href: 'https://x' } }, /must be a string/],
    ['not-a-uuid', { reason: 'other', description: 'x' }, /id must be a valid UUID/],
  ];
  for (const [id, body, message] of cases) {
    const res = await request(disputes).post(`/campaigns/${id}/disputes`).send(body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.match(res.body.error, message);
    assert.ok(Array.isArray(res.body.errors));
  }
});

test('dispute update: validates status enum and resolution_note type/length', async () => {
  const a = app('patch', '/disputes/:id', schemas.disputeUpdateValidation);
  assert.equal((await request(a).patch(`/disputes/${ID}`).send({ status: 'closed', resolution_note: 'done' })).status, 200);
  assert.equal((await request(a).patch(`/disputes/${ID}`).send({ status: 'deleted' })).status, 422);
  assert.equal((await request(a).patch(`/disputes/${ID}`).send({ status: 'closed', resolution_note: 42 })).status, 422);
  assert.equal((await request(a).patch(`/disputes/${ID}`).send({ status: 'closed', resolution_note: 'x'.repeat(5001) })).status, 422);
});

test('api key create: label and scopes are type-, length- and enum-checked', async () => {
  const a = app('post', '/api-keys', schemas.apiKeyCreateValidation);
  assert.equal((await request(a).post('/api-keys').send({})).status, 200, 'both optional');
  assert.equal((await request(a).post('/api-keys').send({ label: 'CI', scopes: ['read'] })).status, 200);
  for (const body of [
    { label: ['CI'] },
    { label: 'x'.repeat(101) },
    { scopes: 'read' },
    { scopes: [] },
    { scopes: ['read', 'root'] },
    { scopes: [{ read: true }] },
  ]) {
    assert.equal((await request(a).post('/api-keys').send(body)).status, 422, JSON.stringify(body));
  }
});

test('notifications: mark-read needs a UUID; preferences must be known boolean flags (400)', async () => {
  const read = app('patch', '/:id/read', schemas.notificationIdValidation, schemas.validateRequestBadRequest);
  assert.equal((await request(read).patch(`/${ID}/read`)).status, 200);
  assert.equal((await request(read).patch('/1;DROP/read')).status, 400);

  const prefs = app('put', '/preferences', schemas.notificationPreferencesValidation, schemas.validateRequestBadRequest);
  assert.equal((await request(prefs).put('/preferences').send({ marketing: false, system: true })).status, 200);
  for (const body of [{ marketing: 'no' }, { admin: true }, [true]]) {
    const res = await request(prefs).put('/preferences').send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('campaign updates: title/body must be non-empty strings within limits; ids must be UUIDs', async () => {
  const create = app('post', '/:id/updates', schemas.campaignUpdateCreateValidation);
  assert.equal((await request(create).post(`/${ID}/updates`).send({ title: 'Week 1', body: '**Shipped**' })).status, 200);
  for (const body of [
    { title: ['x'], body: 'b' },
    { title: 't', body: { $gt: '' } },
    { title: '', body: 'b' },
    { title: 'x'.repeat(201), body: 'b' },
    { title: 't', body: 'x'.repeat(20001) },
  ]) {
    assert.equal((await request(create).post(`/${ID}/updates`).send(body)).status, 422, JSON.stringify(body).slice(0, 60));
  }
  const edit = app('patch', '/:id/updates/:updateId', schemas.campaignUpdateEditValidation);
  assert.equal((await request(edit).patch(`/${ID}/updates/${ID2}`).send({ title: 't', body: 'b' })).status, 200);
  assert.equal((await request(edit).patch(`/${ID}/updates/nope`).send({ title: 't', body: 'b' })).status, 422);
});
