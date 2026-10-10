import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MEMBERSHIP_ROLES, roleFromSegment, type MembershipRole } from '@nio/shared';
import { api } from './api';
import type { Me, Membership } from './auth';

export interface Workspace extends Membership {
  /** True when this entry is reached through the platform admin's audited act-as. */
  actAs: boolean;
}

export function useWorkspaces(email: string | undefined) {
  return useQuery({
    queryKey: ['workspaces', email],
    queryFn: () => api<{ workspaces: Workspace[] }>('/api/workspaces'),
    staleTime: 60_000,
    enabled: Boolean(email),
  });
}

const LAST_WORKSPACE_KEY = 'nio.lastWorkspace';

export interface WorkspaceRef {
  slug: string;
  role: MembershipRole;
}

export function parseWorkspacePath(pathname: string): WorkspaceRef | null {
  const [, prefix, slug, segment] = pathname.split('/');
  if (prefix !== 'w' || !slug) return null;
  const role = roleFromSegment(segment);
  return role ? { slug, role } : null;
}

export function rememberWorkspace(ref: WorkspaceRef): void {
  localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify(ref));
}

export function lastWorkspace(): WorkspaceRef | null {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_WORKSPACE_KEY) ?? 'null');
    return value &&
      typeof value.slug === 'string' &&
      (MEMBERSHIP_ROLES as readonly string[]).includes(value.role)
      ? (value as WorkspaceRef)
      : null;
  } catch {
    return null;
  }
}

/** The membership this session can use directly for a workspace, without acting as anyone. */
export function sessionMembershipFor(me: Me | null, ref: WorkspaceRef): Membership | null {
  return (
    me?.memberships.find((m) => m.businessUnitSlug === ref.slug && m.role === ref.role) ?? null
  );
}

/** A platform session may enter any workspace through the audited act-as header. */
export function canActAs(me: Me | null): boolean {
  return Boolean(me?.isPlatformAdmin && !me.activeOrganizationId);
}

export interface CurrentWorkspace extends WorkspaceRef {
  businessUnitName: string;
  isActingAs: boolean;
}

/** The business unit and role named by the current URL, or null outside a workspace. */
export function useWorkspace(me: Me | null): CurrentWorkspace | null {
  const { pathname } = useLocation();
  const workspaces = useWorkspaces(me?.email);
  const ref = parseWorkspacePath(pathname);
  if (!ref) return null;
  const membership = sessionMembershipFor(me, ref);
  const known =
    me?.availableMemberships.find((m) => m.businessUnitSlug === ref.slug) ??
    workspaces.data?.workspaces.find((w) => w.businessUnitSlug === ref.slug);
  return {
    ...ref,
    businessUnitName: known?.businessUnitName ?? ref.slug,
    isActingAs: !membership && canActAs(me),
  };
}

/**
 * Value for `X-Qinio-Act-As` on a given API path. Resolved per request from the address bar so
 * the header is right even for queries that fire before any effect has run.
 */
export function actAsHeaderFor(me: Me | null, apiPath: string): string | null {
  if (!canActAs(me)) return null;
  const ref = parseWorkspacePath(window.location.pathname);
  if (!ref || !apiPath.startsWith(`/api/bu/${ref.slug}/`)) return null;
  if (sessionMembershipFor(me, ref)) return null;
  return `${ref.slug}:${ref.role}`;
}
