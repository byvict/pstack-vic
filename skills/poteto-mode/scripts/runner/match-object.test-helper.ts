// Subset matcher standing in for bun:test's toMatchObject in the node:test
// port of the open-pstack runner suite.

import assert from "node:assert/strict";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Assert that every key in `expected` is deep-equal in `actual` (recursively for nested objects). */
export function matchObject(
  actual: unknown,
  expected: Record<string, unknown>,
  path: string = ""
): void {
  assert.ok(isRecord(actual), `${path || "value"} is not an object: ${JSON.stringify(actual)}`);
  for (const [key, want] of Object.entries(expected)) {
    const where = path ? `${path}.${key}` : key;
    const got = actual[key];
    if (isRecord(want)) {
      matchObject(got, want, where);
    } else {
      assert.deepEqual(got, want, `${where}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
}

/** Assert that `actual` contains every element of `expected` (order-free, like expect.arrayContaining). */
export function arrayContaining(
  actual: readonly unknown[],
  expected: readonly unknown[]
): void {
  for (const item of expected) {
    assert.ok(
      actual.some((entry) => {
        try {
          assert.deepEqual(entry, item);
          return true;
        } catch {
          return false;
        }
      }),
      `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`
    );
  }
}
