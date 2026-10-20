export const DEFERRED_RESIZE_MESSAGE = 'ResizeObserver loop completed with undelivered notifications.';

/** The browser reports deferred ResizeObserver delivery through ErrorEvent, without a thrown error.
 * Keep real exceptions (including the same text), synthetic events and sourced errors fatal.
 * https://drafts.csswg.org/resize-observer/#deliver-resize-loop-error
 */
export function isDeferredResizeNotification(event: Pick<ErrorEvent, 'isTrusted' | 'message' | 'error' | 'filename' | 'lineno' | 'colno'>, documentUrl: string): boolean {
  return event.isTrusted && event.message === DEFERRED_RESIZE_MESSAGE && event.error == null
    && event.lineno === 0 && event.colno === 0
    && (event.filename === '' || event.filename === documentUrl);
}
