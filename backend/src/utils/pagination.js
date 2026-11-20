/**
 * Opaque keyset-pagination cursors.
 *
 * A cursor encodes the sort value and id of the last row of a page. Sort
 * values are carried as the text Postgres produced (e.g. `created_at::text`),
 * never as JS Dates, which would drop microseconds and skip or repeat rows.
 */

class InvalidCursorError extends Error {
  constructor(message = 'Invalid cursor') {
    super(message);
    this.name = 'InvalidCursorError';
    this.status = 400;
    this.code = 'INVALID_CURSOR';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {{ sort?: string, value: string|null, id: string }} position */
function encodeCursor({ sort, value, id }) {
  return Buffer.from(JSON.stringify({ s: sort, v: value, id }), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor produced by encodeCursor for the given sort.
 * Throws InvalidCursorError (400) for anything else.
 */
function decodeCursor(raw, expectedSort) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (!parsed || typeof parsed !== 'object' || !UUID_RE.test(String(parsed.id))) {
    throw new InvalidCursorError();
  }
  if (typeof parsed.v !== 'string' || parsed.v.length > 64) {
    throw new InvalidCursorError();
  }
  if (expectedSort !== undefined && parsed.s !== expectedSort) {
    throw new InvalidCursorError('Cursor does not match the requested sort');
  }
  return { value: parsed.v, id: parsed.id };
}

/**
 * Splits a LIMIT n+1 result into the page and the next cursor.
 * Each row must carry the sort value in `cursorField`; it is removed from the
 * returned rows.
 */
function pageWithCursor(rows, limit, { sort, cursorField = '_cursor_value' } = {}) {
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map((row) => {
    const { [cursorField]: _omit, ...rest } = row;
    return rest;
  });
  const last = hasMore ? rows[limit - 1] : null;
  const nextCursor = last ? encodeCursor({ sort, value: last[cursorField], id: last.id }) : null;
  return { page, nextCursor };
}

module.exports = { encodeCursor, decodeCursor, pageWithCursor, InvalidCursorError };
