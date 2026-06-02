// Test-only entry point. Importing this pulls in `supertest`, which consumers must
// provide themselves (declared as an optional peer dependency). Kept off the main
// barrel so production connector bundles never load supertest.
export { TestHarness, type TestHarnessConfig } from './TestHarness.js';
