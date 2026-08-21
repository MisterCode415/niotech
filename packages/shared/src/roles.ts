import { z } from 'zod';

/** Roles a user can hold inside a single business unit. */
export const MEMBERSHIP_ROLES = ['bu_admin', 'patient', 'fulfillment', 'lab', 'doctor'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];
export const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);

/**
 * `platform_admin` is deliberately not a membership: it lives in its own alpha table and is
 * scoped to the platform, not to any tenant. `system` represents automated transitions the
 * server performs on its own behalf (payment capture, queue routing, result release).
 */
export const ACTOR_ROLES = [...MEMBERSHIP_ROLES, 'platform_admin', 'system'] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];
export const actorRoleSchema = z.enum(ACTOR_ROLES);

export const BUSINESS_UNIT_STATUSES = ['active', 'suspended', 'removed'] as const;
export type BusinessUnitStatus = (typeof BUSINESS_UNIT_STATUSES)[number];
export const businessUnitStatusSchema = z.enum(BUSINESS_UNIT_STATUSES);

export const USER_STATUSES = ['active', 'invited', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const userStatusSchema = z.enum(USER_STATUSES);

export const ROLE_LABELS: Record<MembershipRole, string> = {
  bu_admin: 'Business Unit Admin',
  patient: 'Patient',
  fulfillment: 'Fulfillment',
  lab: 'Lab',
  doctor: 'Doctor',
};
