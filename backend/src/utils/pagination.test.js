const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeCursor, decodeCursor, pageWithCursor, InvalidCursorError } = require('./pagination');

const ID = '3f2b8c1e-1d2a-4b3c-9d4e-5f6a7b8c9d0e';

test('cursors round-trip the exact Postgres text value and id', () => {
  const value = '2026-10-21 10:00:00.123456+00';
  const cursor = encodeCursor({ sort: 'newest', value, id: ID });
  assert.match(cursor, /^[A-Za-z0-9_-]+$/, 'URL-safe');
  assert.deepEqual(decodeCursor(cursor, 'newest'), { value, id: ID });
});

test('decodeCursor rejects garbage, wrong sorts and non-uuid ids', () => {
  assert.throws(() => decodeCursor('%%%'), InvalidCursorError);
  assert.throws(() => decodeCursor(Buffer.from('[1]').toString('base64url')), InvalidCursorError);
  const other = encodeCursor({ sort: 'most_funded', value: '10', id: ID });
  assert.throws(() => decodeCursor(other, 'newest'), /does not match/);
  const badId = encodeCursor({ sort: 'newest', value: 'x', id: "1' OR 1=1" });
  assert.throws(() => decodeCursor(badId, 'newest'), InvalidCursorError);
  try {
    decodeCursor('%%%');
  } catch (err) {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_CURSOR');
  }
});

test('pageWithCursor trims the extra row, strips the cursor field and points at the last row', () => {
  const rows = [
    { id: 'a0000000-0000-4000-8000-000000000001', _cursor_value: 'v1', n: 1 },
    { id: 'a0000000-0000-4000-8000-000000000002', _cursor_value: 'v2', n: 2 },
    { id: 'a0000000-0000-4000-8000-000000000003', _cursor_value: 'v3', n: 3 },
  ];
  const { page, nextCursor } = pageWithCursor(rows, 2, { sort: 'newest' });
  assert.deepEqual(page, [
    { id: rows[0].id, n: 1 },
    { id: rows[1].id, n: 2 },
  ]);
  assert.deepEqual(decodeCursor(nextCursor, 'newest'), { value: 'v2', id: rows[1].id });

  assert.equal(pageWithCursor(rows.slice(0, 2), 2, { sort: 'newest' }).nextCursor, null);
});
