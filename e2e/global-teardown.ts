import { emergencyTeardown } from "./resource-journal";

// Playwright registers this before invoking setup, including when setup times out
// before it can return its ordinary teardown callback.
export default function globalTeardown() {
  emergencyTeardown();
}
