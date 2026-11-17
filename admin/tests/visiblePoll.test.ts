// @vitest-environment jsdom
/**
 * The notifications polls run only while the tab is visible (review 2026-11-17).
 *
 *   npx vitest run --root admin tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startVisiblePoll } from '../src/utils/visiblePoll';

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (v: DocumentVisibilityState) => {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => vi.useRealTimers());

describe('startVisiblePoll', () => {
  it('polls on the interval while visible, and not at start (callers fetch first themselves)', () => {
    const run = vi.fn();
    const stop = startVisiblePoll(run, 15_000);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(45_000);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it('stops while hidden, then refreshes at once and resumes when visible again', () => {
    const run = vi.fn();
    const stop = startVisiblePoll(run, 15_000);
    setVisibility('hidden');
    vi.advanceTimersByTime(10 * 60_000);
    expect(run).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a second "visible" event does not start a second timer', () => {
    const run = vi.fn();
    const stop = startVisiblePoll(run, 15_000);
    setVisibility('visible');
    setVisibility('visible');
    vi.advanceTimersByTime(15_000);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it('starting in a hidden tab waits for it to be shown', () => {
    visibility = 'hidden';
    const run = vi.fn();
    const stop = startVisiblePoll(run, 15_000);
    vi.advanceTimersByTime(60_000);
    expect(run).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it('cleanup stops the timer and the listener', () => {
    const run = vi.fn();
    const stop = startVisiblePoll(run, 15_000);
    stop();
    vi.advanceTimersByTime(60_000);
    setVisibility('hidden');
    setVisibility('visible');
    expect(run).not.toHaveBeenCalled();
  });
});
