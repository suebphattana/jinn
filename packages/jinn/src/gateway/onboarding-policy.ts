/**
 * Onboarding gate policy.
 * The wizard is needed if and only if the `onboarded` flag has not been set.
 * Employees and sessions are irrelevant — setup always seeds an employee,
 * so checking them caused the wizard to never appear.
 */
export function onboardingNeeded(onboarded: boolean): boolean {
  return !onboarded;
}
