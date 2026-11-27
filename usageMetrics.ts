type NumericTotal = { found: boolean; value: number; invalid: boolean };

function sumNumericLeaves(value: unknown): NumericTotal {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0
      ? { found: true, value, invalid: false }
      : { found: false, value: 0, invalid: true };
  }
  if (Array.isArray(value)) {
    return value.reduce<NumericTotal>((total, item) => {
      const next = sumNumericLeaves(item);
      return {
        found: total.found || next.found,
        value: total.value + next.value,
        invalid: total.invalid || next.invalid,
      };
    }, { found: false, value: 0, invalid: false });
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<NumericTotal>((total, item) => {
      const next = sumNumericLeaves(item);
      return {
        found: total.found || next.found,
        value: total.value + next.value,
        invalid: total.invalid || next.invalid,
      };
    }, { found: false, value: 0, invalid: false });
  }
  return { found: false, value: 0, invalid: false };
}

/** Sum a usage detail across request entries without counting aliases twice. */
export function sumUsageDetail(
  details: unknown,
  aggregateKeys: string[],
  breakdownKey?: string,
): number | null {
  const entries = Array.isArray(details) ? details : [details];
  if (entries.length === 0) return null;

  let total = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const aggregateKey = aggregateKeys.find((key) => Object.prototype.hasOwnProperty.call(record, key));
    const parsed = aggregateKey
      ? sumNumericLeaves(record[aggregateKey])
      : breakdownKey && Object.prototype.hasOwnProperty.call(record, breakdownKey)
        ? sumNumericLeaves(record[breakdownKey])
        : null;

    if (!parsed || !parsed.found || parsed.invalid) return null;
    total += parsed.value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function cacheUsageBreakdown(inputTokens: unknown, details: unknown): {
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  invalid: boolean;
} {
  const cachedInputTokens = sumUsageDetail(details, ['cached_tokens', 'cachedTokens', 'cached_input_tokens']);
  const cacheWriteTokens = sumUsageDetail(
    details,
    ['cache_write_tokens', 'cacheWriteTokens'],
    'cache_write_tokens_details',
  );
  if (cachedInputTokens === null || cacheWriteTokens === null) {
    return { cachedInputTokens: null, cacheWriteTokens: null, invalid: false };
  }
  if (
    !Number.isSafeInteger(inputTokens) || Number(inputTokens) < 0 ||
    cachedInputTokens + cacheWriteTokens > Number(inputTokens)
  ) {
    return { cachedInputTokens: null, cacheWriteTokens: null, invalid: true };
  }
  return { cachedInputTokens, cacheWriteTokens, invalid: false };
}
