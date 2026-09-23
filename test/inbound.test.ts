/**
 * Unit tests for inbound duplicate suppression.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dedup, STALE_TOKEN_ERRCODE } from '../src/inbound.js';

const FIVE_MINUTES_MS = 5 * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('Dedup', () => {
  it('accepts an id the first time and rejects it afterwards', () => {
    const dedup = new Dedup();
    expect(dedup.isDuplicate('m-1')).toBe(false);
    expect(dedup.isDuplicate('m-1')).toBe(true);
    expect(dedup.isDuplicate('m-2')).toBe(false);
  });

  it('never treats a missing id as a duplicate', () => {
    const dedup = new Dedup();
    expect(dedup.isDuplicate(undefined)).toBe(false);
    expect(dedup.isDuplicate(undefined)).toBe(false);
    expect(dedup.isDuplicate('')).toBe(false);
  });

  it('keeps suppressing inside the sliding window', () => {
    vi.useFakeTimers({ now: 0 });
    const dedup = new Dedup();
    expect(dedup.isDuplicate('m-1')).toBe(false);
    vi.setSystemTime(FIVE_MINUTES_MS - 1);
    expect(dedup.isDuplicate('m-1')).toBe(true);
  });

  it('forgets ids once the window has passed', () => {
    vi.useFakeTimers({ now: 0 });
    const dedup = new Dedup();
    expect(dedup.isDuplicate('m-1')).toBe(false);
    vi.setSystemTime(FIVE_MINUTES_MS + 1);
    expect(dedup.isDuplicate('m-1')).toBe(false);
  });
});

describe('STALE_TOKEN_ERRCODE', () => {
  it('matches the backend session-timeout code', () => {
    expect(STALE_TOKEN_ERRCODE).toBe(-14);
  });
});
