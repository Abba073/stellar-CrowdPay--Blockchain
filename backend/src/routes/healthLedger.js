const { sendErrorResponse } = require('../middleware/errorHandler');

const LEDGER_HEALTH_UNAVAILABLE = 'Ledger health check unavailable';

/**
 * GET /health/ledger handler.
 *
 * The endpoint is unauthenticated, so on failure it returns a fixed 503 body
 * and never echoes err.message: Horizon/stream errors can leak upstream
 * endpoints and internal state. Details go to the logs and the alert instead.
 */
function createLedgerHealthHandler({ getLedgerStreamHealth, sendAlert, logger }) {
  return async function ledgerHealth(_req, res) {
    try {
      const body = await getLedgerStreamHealth();
      res.json(body);
    } catch (err) {
      logger.error('Ledger health check failed', { error: err.message, stack: err.stack });
      sendAlert('Ledger health check failed', {
        alert_key: 'ledger_health',
        fingerprint: 'health/ledger',
        severity: 'critical',
        error: err.message,
      });
      sendErrorResponse(res, 503, LEDGER_HEALTH_UNAVAILABLE);
    }
  };
}

module.exports = { createLedgerHealthHandler, LEDGER_HEALTH_UNAVAILABLE };
