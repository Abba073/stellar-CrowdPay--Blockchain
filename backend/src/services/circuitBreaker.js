'use strict';

const { sendAlert } = require('./alerting');

const STATE_CLOSED = 'closed';
const STATE_OPEN = 'open';
const STATE_HALF_OPEN = 'half-open';

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30000;

/**
 * Typed error thrown when a call is rejected because the breaker is open.
 */
class CircuitOpenError extends Error {
  constructor(name, message) {
    super(
      message ||
        `Circuit breaker "${name}" is open; failing fast`
    );
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
    this.circuitName = name;
    this.statusCode = 503;
  }
}

/**
 * Small circuit breaker with closed / open / half-open states.
 *
 * - closed: calls pass through; consecutive failures are counted.
 * - open: calls fail fast with CircuitOpenError until cooldown elapses.
 * - half-open: a single probe call is allowed; success closes the breaker,
 *   failure re-opens it.
 */
class CircuitBreaker {
  /**
   * @param {string} name - Identifier used in errors and alerts.
   * @param {Function} fn - The async function to guard.
   * @param {Object} [options]
   * @param {number} [options.failureThreshold=5] - Consecutive failures to open.
   * @param {number} [options.cooldownMs=30000] - Time before half-open probe.
   * @param {Function} [options.alertFn] - Override alert sender (for tests).
   */
  constructor(name, fn, options = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('CircuitBreaker requires a non-empty name');
    }
    if (typeof fn !== 'function') {
      throw new TypeError('CircuitBreaker requires a function to guard');
    }

    this.name = name;
    this.fn = fn;
    this.failureThreshold =
      Number.isFinite(options.failureThreshold) && options.failureThreshold > 0
        ? options.failureThreshold
        : DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs =
      Number.isFinite(options.cooldownMs) && options.cooldownMs >= 0
        ? options.cooldownMs
        : DEFAULT_COOLDOWN_MS;
    this.alertFn = typeof options.alertFn === 'function' ? options.alertFn : sendAlert;

    this.state = STATE_CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probeInFlight = false;
    this.lastError = null;
  }

  /**
   * Execute the guarded function, applying breaker semantics.
   * @param {...any} args - Arguments forwarded to the guarded function.
   * @returns {Promise<any>}
   */
  async execute(...args) {
    if (this.state === STATE_OPEN) {
      if (!this._cooldownElapsed()) {
        throw new CircuitOpenError(this.name);
      }
      this._transitionToHalfOpen();
    }

    if (this.state === STATE_HALF_OPEN) {
      if (this.probeInFlight) {
        // Only a single probe is allowed while half-open.
        throw new CircuitOpenError(
          this.name,
          `Circuit breaker "${this.name}" is half-open; probe already in flight`
        );
      }
      this.probeInFlight = true;
    }

    try {
      const result = await this.fn(...args);
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    } finally {
      if (this.state === STATE_HALF_OPEN) {
        this.probeInFlight = false;
      }
    }
  }

  /**
   * Current breaker state (for introspection / health checks).
   * @returns {string}
   */
  getState() {
    return this.state;
  }

  /**
   * Reset the breaker to closed and clear counters.
   */
  reset() {
    this.state = STATE_CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probeInFlight = false;
    this.lastError = null;
  }

  _cooldownElapsed() {
    if (this.openedAt === null) {
      return true;
    }
    return Date.now() - this.openedAt >= this.cooldownMs;
  }

  _onSuccess() {
    const previousState = this.state;
    this.consecutiveFailures = 0;
    this.lastError = null;

    if (previousState === STATE_HALF_OPEN) {
      this.state = STATE_CLOSED;
      this.openedAt = null;
      this._alert('circuit_closed', {
        message: `Circuit breaker "${this.name}" recovered and is now closed`,
      });
    } else if (previousState === STATE_OPEN) {
      // Should not normally happen, but keep state consistent.
      this.state = STATE_CLOSED;
      this.openedAt = null;
    }
  }

  _onFailure(err) {
    this.lastError = err;

    if (this.state === STATE_HALF_OPEN) {
      // Probe failed: re-open immediately.
      this._transitionToOpen(err, 'half-open probe failed');
      return;
    }

    this.consecutiveFailures += 1;
    if (
      this.state === STATE_CLOSED &&
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this._transitionToOpen(err, 'failure threshold reached');
    }
  }

  _transitionToOpen(err, reason) {
    const wasOpen = this.state === STATE_OPEN;
    this.state = STATE_OPEN;
    this.openedAt = Date.now();
    this.probeInFlight = false;

    if (!wasOpen) {
      this._alert('circuit_opened', {
        message: `Circuit breaker "${this.name}" opened (${reason})`,
        reason,
        consecutiveFailures: this.consecutiveFailures,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  _transitionToHalfOpen() {
    this.state = STATE_HALF_OPEN;
    this.probeInFlight = false;
    this._alert('circuit_half_open', {
      message: `Circuit breaker "${this.name}" is half-open; allowing a single probe`,
    });
  }

  _alert(type, details) {
    try {
      const result = this.alertFn(type, {
        circuit: this.name,
        state: this.state,
        ...details,
      });
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          /* alerting must never break the breaker */
        });
      }
    } catch (_err) {
      /* alerting must never break the breaker */
    }
  }
}

/**
 * Convenience factory.
 * @param {string} name
 * @param {Function} fn
 * @param {Object} [options]
 * @returns {CircuitBreaker}
 */
function createCircuitBreaker(name, fn, options) {
  return new CircuitBreaker(name, fn, options);
}

module.exports = {
  CircuitBreaker,
  CircuitOpenError,
  createCircuitBreaker,
  STATE_CLOSED,
  STATE_OPEN,
  STATE_HALF_OPEN,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
};