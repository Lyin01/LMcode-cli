/**
 * Startup barrier between runtime initialization and renderer loading.
 *
 * The renderer issues its first IPC invocations as soon as it mounts, so
 * loading it before the harness finished registering its handlers surfaces
 * "No handler registered" errors on slow startups (first-run config
 * creation, config migration, antivirus scans). The main window is therefore
 * created hidden with its trusted URL up front, but the renderer itself is
 * only loaded once `initialization` has resolved — and never when the app
 * already entered shutdown (`shouldSkip`).
 *
 * Returns whether the renderer was loaded.
 */
export async function loadRendererAfterReady(
  initialization: Promise<void>,
  loadRenderer: () => Promise<void>,
  shouldSkip: () => boolean = () => false,
): Promise<boolean> {
  await initialization
  if (shouldSkip()) return false
  await loadRenderer()
  return true
}
