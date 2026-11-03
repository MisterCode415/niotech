import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { BusinessUnitBrand } from '@nio/shared';
import { api, ApiError } from './api';

/** What the server says about the hostname this page was loaded from. */
export type HostInfo =
  | { custom: false }
  | {
      custom: true;
      hostname: string;
      slug: string;
      name: string;
      brand: BusinessUnitBrand | null;
    };

const HostContext = createContext<HostInfo>({ custom: false });

export function useHost(): HostInfo {
  return useContext(HostContext);
}

/**
 * A tenant's own domain serves one business unit at its root, so the app has to know before it
 * routes anything. On the shared platform host this resolves instantly to `{ custom: false }`.
 */
export function HostGate({ children }: { children: ReactNode }) {
  const host = useQuery({
    queryKey: ['host'],
    queryFn: () => api<HostInfo>('/api/public/host'),
    staleTime: Infinity,
    retry: false,
  });

  if (host.isLoading) return <div className="centered">Loading…</div>;

  // An unverified, disabled, or suspended domain answers 404 to everything.
  if (host.error instanceof ApiError && host.error.status === 404) {
    return (
      <div className="centered">
        <div className="auth-card">
          <h1>Not available</h1>
          <p className="muted">This address is not active.</p>
        </div>
      </div>
    );
  }

  return (
    <HostContext.Provider value={host.data ?? { custom: false }}>{children}</HostContext.Provider>
  );
}

/** First path segments that are app routes rather than a business-unit slug. */
const RESERVED_SEGMENTS = new Set(['login', 'callback', 'portal', 'scan', 'checkout', 'w']);

/** The business unit the current URL belongs to, or null on pages that belong to none. */
export function slugFromPath(pathname: string, host: HostInfo): string | null {
  if (host.custom) return host.slug;
  const [, first, second] = pathname.split('/');
  if (!first) return null;
  if (first === 'w') return second || null;
  return RESERVED_SEGMENTS.has(first) ? null : first;
}

export interface BrandInfo {
  slug: string | null;
  name: string | null;
  brand: BusinessUnitBrand | null;
}

/** Brand for the business unit in the URL. Costs no request on a custom domain. */
export function useBrand(): BrandInfo {
  const host = useHost();
  const { pathname } = useLocation();
  const slug = slugFromPath(pathname, host);

  const lookup = useQuery({
    queryKey: ['public', slug, 'brand'],
    queryFn: () =>
      api<{ businessUnit: { name: string; brand: BusinessUnitBrand | null } }>(
        `/api/public/${slug}/login`,
      ),
    enabled: Boolean(slug) && !host.custom,
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (host.custom) return { slug: host.slug, name: host.name, brand: host.brand };
  return {
    slug,
    name: lookup.data?.businessUnit.name ?? null,
    brand: lookup.data?.businessUnit.brand ?? null,
  };
}

const DEFAULT_TITLE = document.title;

/**
 * Re-skins the app for the current business unit: accent color and page title. Rendered once at
 * the top of the tree; leaving a branded area restores the platform defaults.
 */
export function BrandSync() {
  const { brand, name } = useBrand();
  const color = brand?.primaryColor;
  const title = brand?.displayName ?? name;

  useEffect(() => {
    const root = document.documentElement;
    if (color) {
      root.style.setProperty('--accent', color);
      root.style.setProperty('--accent-strong', `color-mix(in srgb, ${color} 82%, black)`);
    }
    return () => {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-strong');
    };
  }, [color]);

  useEffect(() => {
    document.title = title ?? DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [title]);

  return null;
}

/** The wordmark: the tenant's logo or name when it has branded itself, Qinio otherwise. */
export function BrandMark() {
  const host = useHost();
  const { brand, name } = useBrand();
  if (brand?.logoUrl) {
    return (
      <img
        className="brand-logo"
        src={brand.logoUrl}
        alt={brand.displayName ?? name ?? 'Logo'}
        referrerPolicy="no-referrer"
      />
    );
  }
  // On its own domain the tenant is the only identity there is, so its name stands in for a logo.
  const label = brand?.displayName ?? (host.custom ? name : null);
  if (label) return <>{label}</>;
  return (
    <>
      Qin<span>io</span>
    </>
  );
}
