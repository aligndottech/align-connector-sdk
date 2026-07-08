/**
 * Shared constants for the relationship-detection contract.
 *
 * SINGLE SOURCE OF TRUTH (ALI-219) - do not redefine per-side.
 */

/**
 * LLM sampling temperature for relationship classification.
 *
 * Relationship detection must be deterministic: the same decision pair must be
 * typed the same way every run, or measured proof points (conflict/supersession
 * counts) are meaningless. A non-zero temperature makes classification stochastic.
 * Both the gateway/brain path and the CLI local path pin this to 0 (ALI-213/218).
 */
export const DETERMINISTIC_TEMPERATURE = 0;
