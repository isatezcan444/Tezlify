/**
 * Test stub for pino. The durability harness asserts message flow and durable
 * state, not log output, so every level is a no-op and log lines are dropped.
 */
function createLogger() {
  const logger = {
    level: 'silent',
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    silent() {},
    isLevelEnabled() { return false; },
    child() { return createLogger(); },
  };
  return logger;
}

export default function pino() {
  return createLogger();
}

export const stdTimeFunctions = { epochTime() { return 0; } };
