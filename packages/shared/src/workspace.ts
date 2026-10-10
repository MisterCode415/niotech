import type { MembershipRole } from './roles.js';

/** URL segment for each role inside a workspace: `/w/<slug>/<segment>/...`. */
export const ROLE_SEGMENTS: Record<MembershipRole, string> = {
  bu_admin: 'admin',
  patient: 'patient',
  fulfillment: 'fulfillment',
  lab: 'lab',
  doctor: 'doctor',
};

export function roleFromSegment(segment: string | undefined): MembershipRole | null {
  const match = Object.entries(ROLE_SEGMENTS).find(([, value]) => value === segment);
  return match ? (match[0] as MembershipRole) : null;
}

/** Home of a role inside a business unit, optionally followed by a sub-path such as `/orders/1`. */
export function workspacePath(slug: string, role: MembershipRole, subPath = ''): string {
  const home = role === 'patient' ? '/orders' : '';
  return `/w/${slug}/${ROLE_SEGMENTS[role]}${subPath || home}`;
}
