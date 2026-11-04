'use strict';

function elapsedMs(startedAt, finishedAt = Date.now()) {
  return Math.max(0, Number(finishedAt) - Number(startedAt));
}

function logRagMetrics(output, operation, timings = {}, details = {}) {
  const normalizedTimings = {};
  for (const [stage, value] of Object.entries(timings)) {
    if (Number.isFinite(Number(value))) normalizedTimings[stage] = Math.round(Number(value) * 100) / 100;
  }
  const payload = { operation, timings_ms: normalizedTimings, ...details };
  output?.appendLine('[rag:metrics] ' + JSON.stringify(payload));
  return payload;
}

module.exports = { elapsedMs, logRagMetrics };
