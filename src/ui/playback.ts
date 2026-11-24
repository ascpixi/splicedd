/**
 * Represents the right of a single sample to be the one that's played. A claim is made as
 * soon as the user asks for playback, i.e. before the sample is downloaded.
 */
export interface PlaybackClaim {
  /** Whether the sample may (still) be played. Once this becomes `false`, it remains so. */
  readonly active: boolean;

  /** Gives up the claim, invoking its stop callback. Does nothing if it's no longer active. */
  stop(): void;

  /** Gives up the claim without invoking its stop callback. */
  release(): void;
}

/**
 * Makes sure that only one sample is played (or is about to be played) at a time.
 */
export class PlaybackController {
  private current: PlaybackClaim | null = null;

  /**
   * Stops whatever is currently being played, and claims playback for the caller.
   * @param onStop Called when the playback has to be stopped - at most once, and never after a release.
   */
  claim(onStop: () => void): PlaybackClaim {
    this.stop();

    const controller = this;
    const claim: PlaybackClaim = {
      get active() {
        return controller.current == claim;
      },

      stop() {
        if (claim.active) {
          claim.release();
          onStop();
        }
      },

      release() {
        if (claim.active) {
          controller.current = null;
        }
      }
    };

    return this.current = claim;
  }

  /** Stops the current playback, if there's one - even if it hasn't actually started yet. */
  stop() {
    this.current?.stop();
  }
}
