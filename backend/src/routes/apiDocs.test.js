const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..');
const indexSource = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
const apiDoc = fs.readFileSync(path.join(SRC, '..', 'API.md'), 'utf8');

const HTTP_METHODS = 'GET|POST|PUT|PATCH|DELETE';

function joinPath(mount, routePath) {
  return routePath === '/' ? mount : `${mount}${routePath}`;
}

// Every route the running app serves, derived from the mounts in src/index.js.
function implementedRoutes() {
  const routes = new Set();

  const mountRe = /app\.use\(\s*['"]([^'"]+)['"]\s*,\s*require\(\s*['"]\.\/routes\/([^'"]+)['"]\s*\)\s*\)/g;
  for (const [, mount, file] of indexSource.matchAll(mountRe)) {
    const router = require(path.join(__dirname, file));
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        routes.add(`${method.toUpperCase()} ${joinPath(mount, layer.route.path)}`);
      }
    }
  }

  const appRouteRe = new RegExp(`app\\.(${HTTP_METHODS.toLowerCase()})\\(\\s*['"]([^'"]+)['"]`, 'g');
  for (const [, method, routePath] of indexSource.matchAll(appRouteRe)) {
    // `*` is the SPA fallback used when SERVE_FRONTEND=true, not an API route.
    if (routePath === '*') continue;
    routes.add(`${method.toUpperCase()} ${routePath}`);
  }

  return routes;
}

function documentedTableRoutes() {
  const rowRe = new RegExp(`^\\|\\s*\`(${HTTP_METHODS})\`\\s*\\|\\s*\`([^\`]+)\`\\s*\\|`, 'gm');
  return [...apiDoc.matchAll(rowRe)].map(([, method, routePath]) => `${method} ${routePath}`);
}

function documentedHeadingRoutes() {
  const headingRe = new RegExp(`^###\\s+\`(${HTTP_METHODS})\\s+([^\`]+)\``, 'gm');
  return [...apiDoc.matchAll(headingRe)].map(([, method, routePath]) => `${method} ${routePath}`);
}

// Express keeps the first matching layer, so a second identical registration is dead code.
function shadowedRoutes() {
  const seen = new Set();
  const dupes = [];
  const mountRe = /app\.use\(\s*['"]([^'"]+)['"]\s*,\s*require\(\s*['"]\.\/routes\/([^'"]+)['"]\s*\)\s*\)/g;
  for (const [, mount, file] of indexSource.matchAll(mountRe)) {
    const router = require(path.join(__dirname, file));
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        const key = `${method.toUpperCase()} ${joinPath(mount, layer.route.path)}`;
        if (seen.has(key)) dupes.push(`${key} (routes/${file})`);
        seen.add(key);
      }
    }
  }
  return dupes;
}

test('API.md route table lists every implemented route exactly once', () => {
  const implemented = implementedRoutes();
  const documented = documentedTableRoutes();

  const duplicates = documented.filter((route, i) => documented.indexOf(route) !== i);
  assert.deepEqual(duplicates, [], 'routes listed more than once in API.md');

  const documentedSet = new Set(documented);
  const undocumented = [...implemented].filter((route) => !documentedSet.has(route)).sort();
  const phantom = [...documentedSet].filter((route) => !implemented.has(route)).sort();

  assert.deepEqual(undocumented, [], 'implemented routes missing from the API.md route table');
  assert.deepEqual(phantom, [], 'API.md route table documents routes that are not implemented');
});

test('API.md endpoint-detail headings only describe implemented routes', () => {
  const implemented = implementedRoutes();
  const phantom = documentedHeadingRoutes().filter((route) => !implemented.has(route));
  assert.deepEqual(phantom, []);
});

test('API.md marks every alias as deprecated and names its canonical route', () => {
  const implemented = implementedRoutes();
  const rowRe = new RegExp(
    `^\\|\\s*\`(?:${HTTP_METHODS})\`\\s*\\|[^\\n]*\\*\\*Deprecated\\*\\* alias of \`(${HTTP_METHODS}) ([^\`]+)\``,
    'gm'
  );
  const targets = [...apiDoc.matchAll(rowRe)].map(([, method, routePath]) => `${method} ${routePath}`);
  assert.ok(targets.length > 0, 'expected deprecated aliases to be documented');
  for (const target of targets) {
    assert.ok(implemented.has(target), `deprecated alias points at missing route ${target}`);
  }
});

test('no router registers a route that an earlier mount already serves', () => {
  assert.deepEqual(shadowedRoutes(), []);
});

test('removed /api/users auth aliases stay removed', () => {
  const implemented = implementedRoutes();
  assert.equal(implemented.has('POST /api/users/register'), false);
  assert.equal(implemented.has('POST /api/users/login'), false);
  assert.ok(implemented.has('POST /api/auth/register'));
  assert.ok(implemented.has('POST /api/auth/login'));
});
