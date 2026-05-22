import { resolveModelPricing, computeCostFromRecords } from './aggregate.js';
import { getInputTokens, getOutputTokens, getCacheRead, getCacheCreate, isAssistantRecord } from './record-utils.js';

const DEFAULT_SESSION_DURATION_HOURS = 5;

function floorToHourMs(ms) {
  return Math.floor(ms / (60 * 60 * 1000)) * 60 * 60 * 1000;
}

export function identifyBillingBlocks(records, sessionDurationHours = DEFAULT_SESSION_DURATION_HOURS, costMode = 'auto') {
  const sorted = records
    .filter(r => isAssistantRecord(r) && r.timestamp)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (sorted.length === 0) return [];

  const durationMs = sessionDurationHours * 60 * 60 * 1000;
  const blocks = [];
  let blockStartMs = null;
  let blockRecords = [];

  for (const record of sorted) {
    const entryMs = new Date(record.timestamp).getTime();

    if (blockStartMs === null) {
      blockStartMs = floorToHourMs(entryMs);
      blockRecords = [record];
    } else {
      const lastMs = new Date(blockRecords[blockRecords.length - 1].timestamp).getTime();
      const sinceBlockStart = entryMs - blockStartMs;
      const sinceLastEntry = entryMs - lastMs;

      if (sinceBlockStart > durationMs || sinceLastEntry > durationMs) {
        blocks.push(createBlock(blockStartMs, blockRecords, durationMs, costMode));
        blockStartMs = floorToHourMs(entryMs);
        blockRecords = [record];
      } else {
        blockRecords.push(record);
      }
    }
  }

  if (blockStartMs !== null) {
    blocks.push(createBlock(blockStartMs, blockRecords, durationMs, costMode));
  }

  return blocks;
}

function createBlock(startMs, records, durationMs, costMode) {
  const startTime = new Date(startMs);
  const endTime = new Date(startMs + durationMs);
  const lastRecord = records[records.length - 1];
  const actualEndTime = lastRecord ? new Date(lastRecord.timestamp) : startTime;
  const nowMs = Date.now();
  const isActive = (nowMs - actualEndTime.getTime()) < durationMs && nowMs < endTime.getTime();

  let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0;
  const models = new Set();
  const sessions = new Set();

  for (const r of records) {
    inputTokens += getInputTokens(r);
    outputTokens += getOutputTokens(r);
    cacheRead += getCacheRead(r);
    cacheCreate += getCacheCreate(r);
    if (r.model) models.add(r.model);
    if (r.sessionId) sessions.add(r.sessionId);
  }

  const costUSD = computeCostFromRecords(records, costMode);

  return {
    id: startTime.toISOString(),
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    actualEndTime: actualEndTime.toISOString(),
    isActive,
    requests: records.length,
    sessions: sessions.size,
    tokenCounts: { inputTokens, outputTokens, cacheRead, cacheCreate },
    totalTokens: inputTokens + outputTokens + cacheRead + cacheCreate,
    costUSD: Math.round(costUSD * 100) / 100,
    models: [...models],
  };
}
