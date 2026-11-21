'use strict';

const path = require('path');
const proxyquire = require('proxyquire').noCallThru();

describe('backend/src/index.js single-instance guard', () => {
  let expressCallCount;
  let sentryInitCallCount;
  let app;
  let expressMock;
  let sentryMock;
  let indexModule;

  const buildExpressMock = () => {
    const expressMockFn = jest.fn(() => {
      expressCallCount += 1;
      // Minimal express-like app with the methods index.js uses at module scope.
      const appInstance = {
        use: jest.fn(),
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        patch: jest.fn(),
        delete: jest.fn(),
        all: jest.fn(),
        set: jest.fn(),
        listen: jest.fn(() => ({ close: jest.fn() })),
        disable: jest.fn(),
        enable: jest.fn(),
      };
      return appInstance;
    });
    expressMockFn.json = jest.fn(() => jest.fn());
    expressMockFn.urlencoded = jest.fn(() => jest.fn());
    expressMockFn.static = jest.fn(() => jest.fn());
    expressMockFn.Router = jest.fn(() => ({
      use: jest.fn(),
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
      all: jest.fn(),
    }));
    return expressMockFn;
  };

  beforeEach(() => {
    jest.resetModules();
    expressCallCount = 0;
    sentryInitCallCount = 0;

    expressMock = buildExpressMock();

    sentryMock = {
      init: jest.fn(() => {
        sentryInitCallCount += 1;
      }),
      Handlers: {
        requestHandler: jest.fn(() => jest.fn()),
        errorHandler: jest.fn(() => jest.fn()),
        tracingHandler: jest.fn(() => jest.fn()),
      },
      captureException: jest.fn(),
      captureMessage: jest.fn(),
      configureScope: jest.fn(),
      setUser: jest.fn(),
      addBreadcrumb: jest.fn(),
      startTransaction: jest.fn(),
      getCurrentHub: jest.fn(() => ({ getScope: jest.fn(() => ({ setTag: jest.fn() })) })),
    };

    // Stub out heavy/networked dependencies so loading index.js does not bootstrap the server.
    const noopMiddleware = () => jest.fn((req, res, next) => (next ? next() : undefined));

    indexModule = proxyquire(path.join(__dirname, 'index.js'), {
      express: expressMock,
      '@sentry/node': sentryMock,
      './config/database': {
        connect: jest.fn(() => Promise.resolve()),
        disconnect: jest.fn(() => Promise.resolve()),
        getConnection: jest.fn(() => ({ readyState: 1 })),
        '@noCallThru': true,
      },
      './config/redis': {
        getClient: jest.fn(() => null),
        connect: jest.fn(() => Promise.resolve()),
        '@noCallThru': true,
      },
      './middleware/auth': noopMiddleware,
      './middleware/errorHandler': {
        errorHandler: jest.fn((err, req, res, next) => {
          if (res.headersSent) {
            return next(err);
          }
          const status = err.status || err.statusCode || 500;
          const code = err.code || (status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR');
          return res.status(status).json({
            error: {
              code,
              message: err.message || 'Internal Server Error',
            },
          });
        }),
        notFoundHandler: jest.fn((req, res) => {
          return res.status(404).json({
            error: {
              code: 'NOT_FOUND',
              message: `Route not found: ${req.method} ${req.originalUrl || req.url}`,
            },
          });
        }),
        '@noCallThru': true,
      },
      './routes': noopMiddleware,
      './routes/index': noopMiddleware,
      '@noCallThru': true,
    });

    app = indexModule && (indexModule.app || indexModule.default || indexModule);
  });

  it('invokes express() exactly once', () => {
    expect(expressCallCount).toBe(1);
    expect(expressMock).toHaveBeenCalledTimes(1);
  });

  it('invokes Sentry.init exactly once', () => {
    expect(sentryInitCallCount).toBe(1);
    expect(sentryMock.init).toHaveBeenCalledTimes(1);
  });

  it('does not bootstrap the server (no listen call at module load)', () => {
    // The app instance returned by the express mock should not have had listen called
    // during module evaluation. If index.js calls listen at import time, this fails.
    const appInstance = expressMock.mock.results[0].value;
    expect(appInstance.listen).not.toHaveBeenCalled();
  });

  it('returns standardized JSON error envelope for unknown routes', () => {
    expect(app).toBeDefined();

    // Locate the 404 handler registered on the app via app.use(...).
    // The express mock records calls; find the last use() call whose handler
    // is a 2-arg (req, res) function (the not-found handler).
    const useCalls = app.use.mock.calls;
    const notFoundCall = [...useCalls]
      .reverse()
      .find((args) => {
        const handler = args[args.length - 1];
        return typeof handler === 'function' && handler.length === 2;
      });

    expect(notFoundCall).toBeDefined();
    const notFoundHandler = notFoundCall[notFoundCall.length - 1];

    const req = {
      method: 'GET',
      url: '/definitely-not-a-real-route',
      originalUrl: '/definitely-not-a-real-route',
      path: '/definitely-not-a-real-route',
      headers: {},
    };

    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = {
      status,
      json,
      send: jest.fn(),
      end: jest.fn(),
      setHeader: jest.fn(),
      headersSent: false,
    };

    notFoundHandler(req, res, jest.fn());

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledTimes(1);

    const payload = json.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'NOT_FOUND',
          message: expect.any(String),
        }),
      })
    );
    // Ensure it is not a raw string body.
    expect(typeof payload).toBe('object');
    expect(payload.error.message.length).toBeGreaterThan(0);
  });
});