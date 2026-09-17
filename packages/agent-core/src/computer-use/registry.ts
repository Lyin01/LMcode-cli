import { ErrorCodes, LmcodeError } from '#/errors';

import type { ComputerUseProviderId } from './types';

/**
 * Exclusive named registration for the computer-use capability.
 *
 * A session owns exactly one provider slot. A second registration fails even
 * when it repeats the current name, so two providers can never drive the same
 * desktop through one session.
 *
 * The registry deliberately holds nothing else: no provider object, no shared
 * action vocabulary, no dispatch method, no session lock, and no runtime
 * selector. Providers keep their own tools, lifecycle, and platform
 * requirements, and callers coordinate the observe/act/verify workflow across
 * sessions because registration does not reserve the desktop.
 */
export class ComputerUseRegistry {
  private registration: ComputerUseProviderId | undefined;

  /** Name of the registered provider, including while its resources are closing. */
  get providerName(): ComputerUseProviderId | undefined {
    return this.registration;
  }

  /**
   * Reserve the sole provider slot until the returned disposer runs.
   *
   * A provider must stop its tools and await owned work before releasing this
   * registration; releasing it earlier would admit a second live driver while
   * the first one is still tearing down.
   */
  register(name: ComputerUseProviderId): () => void {
    if (this.registration !== undefined) {
      throw new LmcodeError(
        ErrorCodes.COMPUTER_USE_PROVIDER_REGISTERED,
        `Computer use provider "${this.registration}" is already registered`,
      );
    }
    this.registration = name;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.registration = undefined;
    };
  }
}
