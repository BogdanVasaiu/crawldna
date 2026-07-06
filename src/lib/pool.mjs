// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Bogdan Marian Vasaiu
// A tiny fixed-size concurrency pool.

/**
 * Run `fn` over `items` with at most `concurrency` in flight.
 * Results are returned in input order. `shouldStop()` (optional) is polled
 * between items so a graceful stop drains quickly. Errors are captured per
 * item as `{ __error }` rather than rejecting the whole batch.
 */
export async function mapPool(items, concurrency, fn, { shouldStop } = {}) {
  const results = new Array(items.length);
  const size = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      if (shouldStop && shouldStop()) return;
      const i = cursor++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { __error: err };
      }
    }
  }

  await Promise.all(Array.from({ length: size }, worker));
  return results;
}
