import React from "react";

/**
 * Represents a shared audio context.
 */
export interface SamplePlaybackContext {
  cancellation: SamplePlaybackCancellation | null;
  setCancellation: React.Dispatch<React.SetStateAction<SamplePlaybackCancellation | null>>;
}

/**
 * Represents a function that can signal to the current owner of a given context to
 * give up control over said context.
 */
export type SamplePlaybackCancellation = () => void;