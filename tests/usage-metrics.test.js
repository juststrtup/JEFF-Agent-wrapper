const test = require('node:test');
const assert = require('node:assert/strict');
const { cacheUsageBreakdown } = require('../dist/usageMetrics.js');

test('uses aggregate cache-write tokens once when the TTL breakdown is also present', () => {
  const result = cacheUsageBreakdown(1090, [{
    cached_tokens: 0,
    cache_write_tokens: 1087,
    cache_write_tokens_details: { ttl_30m_tokens: 1087, ttl_12h_tokens: 0 },
  }]);

  assert.deepEqual(result, { cachedInputTokens: 0, cacheWriteTokens: 1087, invalid: false });
});

test('sums distinct request entries and chooses one alias per entry', () => {
  const result = cacheUsageBreakdown(100, [
    { cached_tokens: 2, cachedTokens: 2, cache_write_tokens: 20 },
    { cached_tokens: 3, cacheWriteTokens: 10 },
  ]);

  assert.deepEqual(result, { cachedInputTokens: 5, cacheWriteTokens: 30, invalid: false });
});

test('uses nested TTL details only when the aggregate is absent', () => {
  const result = cacheUsageBreakdown(50, [{
    cached_tokens: 0,
    cache_write_tokens_details: { ttl_30m_tokens: 15, ttl_12h_tokens: 10 },
  }]);

  assert.deepEqual(result, { cachedInputTokens: 0, cacheWriteTokens: 25, invalid: false });
});

test('marks an impossible cache breakdown unavailable instead of reporting it as usage', () => {
  const result = cacheUsageBreakdown(20, [{
    cached_tokens: 2,
    cache_write_tokens: 19,
    cache_write_tokens_details: { ttl_30m_tokens: 19 },
  }]);

  assert.deepEqual(result, { cachedInputTokens: null, cacheWriteTokens: null, invalid: true });
});
