/**
 * Server-only accessor for the container-mode flag (JOBFINDER_CONTAINER=1,
 * baked into the Docker image). When set, the two host-OS integrations degrade
 * gracefully: "open folder" becomes a copy-path affordance and the native
 * toast notifier is a silent no-op. Native runs (flag unset) are unchanged.
 * Each degrading module performs exactly one boundary check via this accessor.
 */

/** True iff the app runs in container mode (JOBFINDER_CONTAINER=1). */
export function isContainerMode(): boolean {
  return process.env.JOBFINDER_CONTAINER?.trim() === '1';
}
