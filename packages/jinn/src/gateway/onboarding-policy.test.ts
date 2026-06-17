import { test, expect } from "vitest";
import { onboardingNeeded } from "./onboarding-policy.js";

test("onboarding is needed when not onboarded, regardless of seeded employee/sessions", () => {
  expect(onboardingNeeded(false)).toBe(true);
});

test("onboarding is not needed once onboarded flag is set", () => {
  expect(onboardingNeeded(true)).toBe(false);
});
