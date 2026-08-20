/**
 * Validates that a string is usable as a BullMQ `jobId`, and fails LOUDLY
 * and IMMEDIATELY if it isn't — rather than letting a bad id reach BullMQ
 * and fail there.
 *
 * This exists because of a real conflict discovered by testing against
 * BullMQ directly (bullmq 5.x, `classes/job.js`): a jobId is rejected if it
 * is a bare integer, OR if it contains `:` UNLESS there are EXACTLY 2 (a
 * legacy repeatable-job compatibility carve-out BullMQ's own source marks
 * for removal in a future breaking change — see the `// TODO: replace this
 * check ... with include(':')` comment there). This directly conflicts with
 * the Phase 1 design doc's own dedupe_key examples in §6.6, most of which
 * use exactly ONE colon (`payment.capture:<paymentId>`,
 * `joinRequest.expire:<requestId>`, `review.window.close:<eventId>`), which
 * BullMQ would reject outright — while `event.lifecycle:<id>:<status>`
 * (two colons) would accidentally be ALLOWED by the same legacy loophole.
 * That inconsistency — silently fine for some topics, permanently
 * undeliverable for others depending on how many colons the id happens to
 * contain — is worse than an outright ban, so this validation is
 * deliberately stricter than BullMQ's actual rule: it rejects ANY colon,
 * not just the "wrong number of colons" case, and tells the caller to use a
 * colon-free separator (e.g. `payment.capture.<paymentId>`) instead.
 *
 * Because `dedupe_key` is used verbatim as the jobId (§6.3), and because a
 * dedupe_key that fails this check would fail on EVERY publish attempt
 * forever (retry cannot fix a structurally invalid id), this must be
 * checked at enqueue time — before the row is even committed to
 * `job_outbox` — not discovered later as a permanently-failing publish that
 * eventually dead-letters with no realistic path to succeeding.
 */
export function assertBullMqCompatibleJobId(jobId: string): void {
  if (jobId.length === 0) {
    throw new Error('jobId (dedupe_key) must not be empty.');
  }
  if (/^-?\d+$/.test(jobId)) {
    throw new Error(
      `jobId "${jobId}" is not usable as a BullMQ jobId: purely-numeric ids are rejected by BullMQ.`,
    );
  }
  if (jobId.includes(':')) {
    throw new Error(
      `jobId "${jobId}" is not usable as a BullMQ jobId: BullMQ rejects ids containing ':' in the ` +
        `general case (a narrow legacy exception exists for exactly 2 colons, but relying on it is ` +
        `fragile — see this function's doc comment). Use a colon-free separator instead, e.g. ` +
        `"topic.identifier" rather than "topic:identifier".`,
    );
  }
}
