/**
 * Shared validation utilities for all services and connectors
 *
 * This is the SINGLE SOURCE OF TRUTH for validation - do not duplicate in other packages.
 */

/**
 * UUID format validation regex pattern
 * Matches standard UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 * Note: validates general UUID structure, not specifically v4.
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check if a string is a valid UUID format
 * @param value - The string to validate
 * @returns true if the string is a valid UUID format
 */
export function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Validate a UUID and throw an error if invalid
 * @param value - The string to validate
 * @param fieldName - Name of the field for error message
 * @throws Error if the value is not a valid UUID
 */
export function assertValidUUID(value: string, fieldName = 'value'): void {
  if (!isValidUUID(value)) {
    throw new Error(`Invalid UUID format for ${fieldName}: ${value}`);
  }
}
