export function validateAgentIdentity<T extends { teamId?: string; userId?: string }>(owner: T): asserts owner is T & { teamId: string; userId: string } {
  if (!owner.teamId || !owner.userId || !/^[A-Z0-9]{2,32}$/.test(owner.teamId) || !/^[A-Z0-9]{2,32}$/.test(owner.userId)) {
    throw new Error("Personal agents need a signed Slack workspace and user context.");
  }
}
