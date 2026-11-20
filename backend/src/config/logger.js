const winston = require('winston');
const { getRequestContext } = require('./requestContext');

const isDev = process.env.NODE_ENV !== 'production';
const REDACTED = '[REDACTED]';
const STELLAR_SECRET_PATTERN = /^S[A-Z2-7]{55}$/;
const SENSITIVE_KEY_PATTERN = /(secret|private.?key|seed|token|authorization|cookie|password)/i;

function sanitizeValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return STELLAR_SECRET_PATTERN.test(value) ? REDACTED : value;
  }

  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeValue(entry, seen),
    ])
  );
}

function sanitizeInfoObject(info) {
  const sanitized = sanitizeValue(info);
  for (const key of Object.keys(info)) {
    delete info[key];
  }
  Object.assign(info, sanitized);
  return info;
}

const addRequestId = winston.format((info) => {
  const { requestId } = getRequestContext();
  if (requestId) info.request_id = requestId;
  return sanitizeInfoObject(info);
});

const redactSensitiveValues = winston.format((info) => {
  return info;
});

const DEFAULT_LEVEL = 'info';
const VALID_LEVELS = Object.keys(winston.config.npm.levels);

function resolveLogLevel(rawLevel) {
  if (!rawLevel) return DEFAULT_LEVEL;
  const normalized = String(rawLevel).trim().toLowerCase();
  if (VALID_LEVELS.includes(normalized)) return normalized;
  // eslint-disable-next-line no-console
  console.warn(
    `[logger] Invalid LOG_LEVEL "${rawLevel}"; falling back to "${DEFAULT_LEVEL}". Valid levels: ${VALID_LEVELS.join(', ')}`
  );
  return DEFAULT_LEVEL;
}

function parseModuleOverrides(rawOverrides) {
  const overrides = {};
  if (!rawOverrides) return overrides;

  for (const entry of String(rawOverrides).split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      // eslint-disable-next-line no-console
      console.warn(`[logger] Ignoring malformed LOG_LEVEL_MODULES entry "${trimmed}" (expected module=level).`);
      continue;
    }
    const moduleName = trimmed.slice(0, separatorIndex).trim();
    const rawLevel = trimmed.slice(separatorIndex + 1).trim();
    if (!moduleName) {
      // eslint-disable-next-line no-console
      console.warn(`[logger] Ignoring LOG_LEVEL_MODULES entry "${trimmed}" with empty module name.`);
      continue;
    }
    const level = resolveLogLevel(rawLevel);
    overrides[moduleName] = level;
  }

  return overrides;
}

const baseLevel = resolveLogLevel(process.env.LOG_LEVEL);
const moduleOverrides = parseModuleOverrides(process.env.LOG_LEVEL_MODULES);

// Applies per-module level overrides by dropping records below the configured
// level for the module that emitted them. Records without a module (or with a
// module that has no override) are left untouched and use the base level.
const applyModuleLevelOverrides = winston.format((info) => {
  const moduleName = info.module || info.moduleName;
  if (!moduleName || !Object.prototype.hasOwnProperty.call(moduleOverrides, moduleName)) {
    return info;
  }
  const overrideLevel = moduleOverrides[moduleName];
  if (info.level !== overrideLevel && !winston.config.npm.levels[info.level]) {
    return info;
  }
  const threshold = winston.config.npm.levels[overrideLevel];
  const current = winston.config.npm.levels[info.level];
  if (current === undefined) return info;
  return current <= threshold ? info : false;
});

const logger = winston.createLogger({
  level: baseLevel,
  format: winston.format.combine(
    addRequestId(),
    redactSensitiveValues(),
    applyModuleLevelOverrides(),
    winston.format.timestamp(),
    isDev
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, request_id, ...meta }) => {
            const idStr = request_id ? ` [${String(request_id).slice(0, 8)}]` : '';
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${timestamp}${idStr} ${level}: ${message}${metaStr}`;
          })
        )
      : winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

logger.levels = winston.config.npm.levels;
logger.moduleOverrides = moduleOverrides;

module.exports = logger;
