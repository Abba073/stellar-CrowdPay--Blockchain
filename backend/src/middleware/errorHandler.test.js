const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const {
  sendErrorResponse,
  normalizeErrorResponse,
  errorHandler,
} = require('./errorHandler');

function buildApp(register) {
  const app = express();
  app.use(normalizeErrorResponse);
  register(app);
  app.use(errorHandler);
  return app;
}

test('sendErrorResponse sends { error: { code, message, fields } } with a status-derived code', async () => {
  const app = buildApp((a) => {
    a.get('/x', (req, res) => sendErrorResponse(res, 404, 'Campaign not found'));
    a.get('/y', (req, res) =>
      sendErrorResponse(res, 422, 'Bad amount', { amount: 'Bad amount' })
    );
  });

  const notFound = await request(app).get('/x');
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.body, {
    error: { code: 'NOT_FOUND', message: 'Campaign not found' },
  });

  const invalid = await request(app).get('/y');
  assert.deepEqual(invalid.body, {
    error: { code: 'VALIDATION_ERROR', message: 'Bad amount', fields: { amount: 'Bad amount' } },
  });
});

test('sendErrorResponse supports a custom code and extra top-level keys', async () => {
  const app = buildApp((a) => {
    a.get('/x', (req, res) =>
      sendErrorResponse(res, 503, 'Try later', undefined, 'CIRCUIT_OPEN', { retryable: true })
    );
  });
  const res = await request(app).get('/x');
  assert.deepEqual(res.body, {
    retryable: true,
    error: { code: 'CIRCUIT_OPEN', message: 'Try later' },
  });
});

test('normalizeErrorResponse coerces legacy shapes into the envelope with a status-derived code', async () => {
  const app = buildApp((a) => {
    a.get('/string', (req, res) => res.status(409).json({ error: 'Already exists', detail: 'x' }));
    a.get('/nocode', (req, res) => res.status(403).json({ error: { message: 'Nope' } }));
    a.get('/bare', (req, res) => res.status(400).json({ message: 'odd' }));
  });

  const s = await request(app).get('/string');
  assert.deepEqual(s.body, { detail: 'x', error: { code: 'CONFLICT', message: 'Already exists' } });

  const n = await request(app).get('/nocode');
  assert.deepEqual(n.body, { error: { code: 'FORBIDDEN', message: 'Nope' } });

  const b = await request(app).get('/bare');
  assert.equal(b.body.error.code, 'BAD_REQUEST');
  assert.equal(typeof b.body.error.message, 'string');
});

test('errorHandler sends the envelope for thrown errors', async () => {
  const app = buildApp((a) => {
    a.get('/boom', () => {
      const err = new Error('Invalid amount');
      err.status = 422;
      throw err;
    });
  });
  const res = await request(app).get('/boom');
  assert.equal(res.status, 422);
  assert.deepEqual(res.body, { error: { code: 'VALIDATION_ERROR', message: 'Invalid amount' } });
});

test('no route or middleware sends a bare-string or code-less error body', () => {
  // Every failure must go through sendErrorResponse (or next(err)) so clients
  // can rely on error.code. This guards against regressions in new code.
  const srcDir = path.join(__dirname, '..');
  const files = [
    ...fs.readdirSync(path.join(srcDir, 'routes')).map((f) => path.join(srcDir, 'routes', f)),
    ...fs.readdirSync(path.join(srcDir, 'middleware')).map((f) => path.join(srcDir, 'middleware', f)),
    path.join(srcDir, 'index.js'),
  ].filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !f.endsWith('errorHandler.js'));

  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /\.json\(\s*\{\s*errors?\s*:(?!\s*\{)/g;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${path.relative(srcDir, file)}:${line}`);
    }
    // Structured errors written by hand must still carry a code.
    const structured = /\.json\(\s*\{\s*error\s*:\s*\{([^}]*)\}/g;
    while ((m = structured.exec(src))) {
      if (!/\bcode\s*:/.test(m[1])) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(srcDir, file)}:${line} (missing code)`);
      }
    }
  }
  assert.deepEqual(offenders, [], `use sendErrorResponse instead:\n${offenders.join('\n')}`);
});
