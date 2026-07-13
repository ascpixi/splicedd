/**
 * Class fragments that make HeroUI buttons and toggle buttons match the
 * outline-field styling of inputs and select triggers (see styles.css).
 */

/**
 * Suppresses the scale-down-on-press effect HeroUI applies to buttons. Used on
 * controls that act as fields (dropdown triggers, tag pills), which shouldn't
 * shrink — the real fields (inputs, selects) don't.
 */
export const NO_PRESS_SCALE = "active:[transform:none] data-pressed:[transform:none]";

/**
 * Makes a Button look like a form field: field background, field border
 * radius, and the field hover tint.
 */
export const FIELD_BUTTON_CLASSES = [
  "rounded-field",
  "[--button-bg:var(--field-background)]",
  "[--button-bg-hover:var(--field-hover)]",
  "[--button-bg-pressed:var(--field-hover)]"
].join(" ");

/**
 * Restyles a ToggleButton into a tag pill that matches the outline-field look:
 * field background with a border, keeping the accent-soft treatment when
 * selected.
 */
export const TAG_PILL_CLASSES = [
  "rounded-field border border-border",
  "[--toggle-button-bg:var(--field-background)]",
  "[--toggle-button-bg-hover:var(--field-hover)]",
  "[--toggle-button-bg-pressed:var(--field-hover)]",
  "data-selected:border-transparent",
  NO_PRESS_SCALE
].join(" ");
