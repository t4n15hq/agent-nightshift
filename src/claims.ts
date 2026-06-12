export const CLAIM_MARKER_PREFIX = "<!-- night-worker-claim:";

export function makeClaimMarker(now = new Date()): string {
  return `${CLAIM_MARKER_PREFIX}${now.toISOString()} -->`;
}

export function claimAgeMinutes(
  commentBody: string,
  now = new Date(),
): number | undefined {
  const match = commentBody.match(/<!-- night-worker-claim:([^ ]+) -->/);
  if (!match) {
    return undefined;
  }
  const claimedAt = new Date(match[1]);
  if (Number.isNaN(claimedAt.getTime())) {
    return undefined;
  }
  return (now.getTime() - claimedAt.getTime()) / 60_000;
}
