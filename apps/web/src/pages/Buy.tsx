import { useEffect, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import type { CheckoutAttribution } from '@nio/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { attributionFromParams, saveHandoff } from '../lib/handoff';
import { Loading } from '../components/ui';

interface ResolvedIntent {
  intent: {
    id: string;
    packageId: string;
    returnUrl: string | null;
    attribution: CheckoutAttribution | null;
  };
}

/**
 * Landing page for "Buy" links on a tenant's own marketing site. It records the handoff (campaign
 * tags plus, when present, a validated intent) and forwards the shopper into the existing order
 * flow. A stale or unknown intent is not an error for the shopper: they still get to buy.
 */
export function Buy() {
  const { slug = '', packageId = '' } = useParams();
  const [params] = useSearchParams();
  const { me, loading } = useAuth();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const intentId = params.get('intent');
    const fromUrl = attributionFromParams(params);

    async function capture() {
      let intent: ResolvedIntent['intent'] | null = null;
      if (intentId) {
        try {
          const resolved = await api<ResolvedIntent>(
            `/api/public/${slug}/checkout-intents/${encodeURIComponent(intentId)}`,
          );
          // An intent is bound to one package; ignore it if the link was edited.
          if (resolved.intent.packageId === packageId) intent = resolved.intent;
        } catch {
          // Expired or unknown intent: continue without it.
        }
      }
      if (cancelled) return;
      saveHandoff(slug, {
        packageId,
        ...(intent ? { intentId: intent.id } : {}),
        ...(intent?.returnUrl ? { returnUrl: intent.returnUrl } : {}),
        attribution: { ...fromUrl, ...(intent?.attribution ?? {}) },
      });
      setReady(true);
    }

    void capture();
    return () => {
      cancelled = true;
    };
  }, [slug, packageId, params]);

  if (!ready || loading) return <div className="page"><Loading what="checkout" /></div>;

  const isPatientHere = me?.memberships.some(
    (m) => m.businessUnitSlug === slug && m.role === 'patient',
  );
  return (
    <Navigate
      replace
      to={isPatientHere ? `/${slug}/checkout/${packageId}` : `/${slug}/order/${packageId}`}
    />
  );
}
