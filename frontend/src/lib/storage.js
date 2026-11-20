function getStorage(type) {
  try {
    return type === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export function getStorageItem(key, type = 'local') {
  const storage = getStorage(type);
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function setStorageItem(key, value, type = 'local') {
  const storage = getStorage(type);
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeStorageItem(key, type = 'local') {
  const storage = getStorage(type);
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
