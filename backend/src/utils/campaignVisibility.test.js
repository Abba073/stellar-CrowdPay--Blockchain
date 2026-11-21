const { findVisibleCampaign } = require('./campaignVisibility');

function createStubDb(rows = []) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      return { rows };
    }),
  };
}

describe('findVisibleCampaign', () => {
  test('defaults to selecting the id column', async () => {
    const db = createStubDb([{ id: 1 }]);
    const result = await findVisibleCampaign(db, 1);
    expect(result).toEqual({ id: 1 });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('SELECT id FROM campaigns');
    expect(db.calls[0].params).toEqual([1]);
  });

  test('passes through a valid column list', async () => {
    const db = createStubDb([{ id: 1, name: 'Test', status: 'active' }]);
    const result = await findVisibleCampaign(db, 1, 'id, name, status');
    expect(result).toEqual({ id: 1, name: 'Test', status: 'active' });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('SELECT id, name, status FROM campaigns');
    expect(db.calls[0].params).toEqual([1]);
  });

  test('accepts a single valid column', async () => {
    const db = createStubDb([{ name: 'Test' }]);
    const result = await findVisibleCampaign(db, 1, 'name');
    expect(result).toEqual({ name: 'Test' });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('SELECT name FROM campaigns');
  });

  test('rejects SQL injection via semicolon and DROP TABLE', async () => {
    const db = createStubDb();
    await expect(
      findVisibleCampaign(db, 1, 'id; DROP TABLE users')
    ).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });

  test('rejects SQL injection via subquery', async () => {
    const db = createStubDb();
    await expect(
      findVisibleCampaign(db, 1, 'id, (SELECT password_hash FROM users)')
    ).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });

  test('rejects unknown column names', async () => {
    const db = createStubDb();
    await expect(
      findVisibleCampaign(db, 1, 'password_hash')
    ).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });

  test('rejects empty column list', async () => {
    const db = createStubDb();
    await expect(findVisibleCampaign(db, 1, '')).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });

  test('rejects non-string column input', async () => {
    const db = createStubDb();
    await expect(findVisibleCampaign(db, 1, null)).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });
});