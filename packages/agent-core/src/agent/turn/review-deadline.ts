import { isAbortError } from '../../loop/errors';
import { abortable, createDeadlineAbortSignal } from '../../utils/abort';

const REVIEW_TIMEOUT_MS = 30_000;

export async function withReviewDeadline<T>(
  signal: AbortSignal,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const deadline = createDeadlineAbortSignal(signal, REVIEW_TIMEOUT_MS);
  try {
    return await abortable(run(deadline.signal), deadline.signal);
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.timedOut()) throw new Error(`${label} timed out after 30 seconds`, { cause: error });
    if (isAbortError(error)) throw new Error(`${label} aborted unexpectedly`, { cause: error });
    throw error;
  } finally {
    deadline.clear();
  }
}

export function escapeXmlText(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
