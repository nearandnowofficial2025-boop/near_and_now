/**
 * A poll that runs only while the tab is visible (review 2026-11-17).
 *
 * The notifications bell and the Notifications page polled every 15 s even in
 * a background tab: 2 queries a poll, so a forgotten tab made ~11,500 requests
 * a day. Orders, Delivery and Stores already pause when hidden; this is the
 * same rule. Hidden → stop; visible again → one immediate run, then the
 * interval resumes.
 *
 * Returns the cleanup. `run` is not called at start: callers already do their
 * own first fetch.
 */
export function startVisiblePoll(run: () => void, intervalMs: number, doc: Document = document): () => void {
  let id: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (id == null) id = setInterval(run, intervalMs);
  };
  const stop = () => {
    if (id != null) {
      clearInterval(id);
      id = null;
    }
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') {
      stop();
    } else if (id == null) {
      run();
      start();
    }
  };
  if (doc.visibilityState !== 'hidden') start();
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
