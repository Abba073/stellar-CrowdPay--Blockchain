const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function getRequestContext() {
  return als.getStore() || {};
}

function runWithContext(context, fn) {
  return als.run(context, fn);
}

function captureRequestContext() {
  const store = als.getStore();
  if (!store) {
    return undefined;
  }
  return { ...store };
}

function runWithCapturedContext(captured, fn) {
  if (captured) {
    return als.run(captured, fn);
  }
  return fn();
}

module.exports = {
  getRequestContext,
  runWithContext,
  captureRequestContext,
  runWithCapturedContext,
};