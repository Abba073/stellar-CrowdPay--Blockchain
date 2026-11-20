import { describe, it, expect, vi, afterEach } from 'vitest';
import { getStorageItem, setStorageItem, removeStorageItem } from './storage';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storage helpers', () => {
  it('reads and writes local storage', () => {
    setStorageItem('safe-storage-test', 'value');
    expect(getStorageItem('safe-storage-test')).toBe('value');
    removeStorageItem('safe-storage-test');
    expect(getStorageItem('safe-storage-test')).toBeNull();
  });

  it('reads and writes session storage', () => {
    setStorageItem('safe-session-test', 'value', 'session');
    expect(getStorageItem('safe-session-test', 'session')).toBe('value');
    removeStorageItem('safe-session-test', 'session');
    expect(getStorageItem('safe-session-test', 'session')).toBeNull();
  });

  it('does not throw when getItem is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage is disabled');
    });
    expect(getStorageItem('any-key')).toBeNull();
  });

  it('does not throw when setItem is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage is disabled');
    });
    expect(setStorageItem('any-key', 'value')).toBe(false);
  });

  it('does not throw when removeItem is unavailable', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('Storage is disabled');
    });
    expect(removeStorageItem('any-key')).toBe(false);
  });
});
