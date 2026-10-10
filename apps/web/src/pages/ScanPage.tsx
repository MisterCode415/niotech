import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { KIT_STATUS_LABELS, ROLE_LABELS, type KitStatus, type MembershipRole } from '@nio/shared';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Loading, StatusBadge, AddressBlock } from '../components/ui';
import { KitSerialEntry } from '../components/KitSerialEntry';

type ScanOutcome =
  'none' | 'registered_received' | 'checked_in' | 'open_for_results' | 'open_order';

interface ScanResult {
  businessUnit: { slug: string; name: string };
  role: MembershipRole | null;
  roleChoices: MembershipRole[];
  outcome: ScanOutcome;
  redirect: string | null;
  caughtUp: KitStatus[];
  kit: {
    id: string;
    number: number;
    serial: string;
    status: KitStatus;
    testTypeName: string;
    sampleType: string;
    externalKitId: string | null;
  };
  order: {
    id: string;
    orderNumber: string;
    status: string;
    packageName: string;
    externalFulfillmentId: string | null;
    patientName: string | null;
  };
  labReturnLabel: {
    labName: string;
    address: Parameters<typeof AddressBlock>[0]['address'];
    reference: string;
  } | null;
  orderPath: string | null;
  actions: Array<{ id: string; label: string; method: 'POST'; path: string }>;
}

const ORG_RETRY_KEY = 'nio.scanOrgRetry';

function outcomeMessage(view: ScanResult): string | null {
  const serial = view.kit.serial;
  switch (view.outcome) {
    case 'registered_received':
      return `Kit ${serial} registered as received. When you have collected your sample, mail it using the return label and tap "I've mailed my sample".`;
    case 'checked_in':
      return `Kit ${serial} checked in at the lab. Scan it again, or open the order, when you are ready to upload results.`;
    default:
      return null;
  }
}

/**
 * One QR code, scanned by whoever is holding the kit. Landing here performs the scanner's next
 * step (the server decides which, from their role and the kit's status) and then either shows
 * what happened or forwards them to where their work on this kit continues.
 */
export function ScanPage() {
  const { code = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const as = searchParams.get('as') as MembershipRole | null;
  const navigate = useNavigate();
  const location = useLocation();
  const { signInWithAuth0 } = useAuth();
  const [view, setView] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const started = useRef<string | null>(null);

  const scan = useMutation({
    mutationFn: () =>
      api<ScanResult>(`/api/scan/${encodeURIComponent(code)}`, {
        method: 'POST',
        body: as ? { as } : {},
      }),
    onSuccess: (result) => {
      sessionStorage.removeItem(`${ORG_RETRY_KEY}:${code}`);
      if (result.redirect) {
        navigate(result.redirect, { replace: true });
        return;
      }
      setView(result);
    },
    onError: (err: Error) => {
      const retryKey = `${ORG_RETRY_KEY}:${code}`;
      if (
        err instanceof ApiError &&
        err.code === 'ORGANIZATION_REQUIRED' &&
        !sessionStorage.getItem(retryKey)
      ) {
        // Remembered so a misconfigured organization cannot bounce the scanner through Auth0 forever.
        sessionStorage.setItem(retryKey, '1');
        const organization = err.details?.organization;
        void signInWithAuth0({
          organization: typeof organization === 'string' ? organization : undefined,
          returnTo: location.pathname + location.search,
        });
        return;
      }
      setError(err.message);
    },
  });

  // React's development double-invoke must not scan twice; the server is idempotent regardless.
  useEffect(() => {
    const key = `${code}|${as ?? ''}`;
    if (started.current === key) return;
    started.current = key;
    setView(null);
    setError(null);
    setNotice(null);
    scan.mutate();
  }, [code, as]);

  const perform = useMutation({
    mutationFn: (path: string) => api(path, { method: 'POST' }),
    onSuccess: async () => {
      setNotice({ tone: 'success', text: 'Done. The order has been updated.' });
      const query = view?.role ? `?as=${view.role}` : '';
      setView(await api<ScanResult>(`/api/scan/${encodeURIComponent(code)}${query}`));
    },
    onError: (err: Error) => setNotice({ tone: 'error', text: err.message }),
  });

  if (error) {
    return (
      <div className="stack" style={{ maxWidth: 520 }}>
        <Alert tone="error">{error}</Alert>
        <div className="card">
          <div className="card-title">Enter the kit serial instead</div>
          <p className="small muted">It is printed under the QR code, like QK-7F3K-9M2P.</p>
          <KitSerialEntry />
        </div>
      </div>
    );
  }
  if (!view) return <Loading what="kit" />;

  if (view.roleChoices.length > 0) {
    return (
      <div className="card stack" style={{ maxWidth: 520 }}>
        <div className="card-title">{view.businessUnit.name}</div>
        <h2 style={{ margin: 0 }}>Kit {view.kit.serial}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          You hold more than one role here. Which are you scanning this kit as?
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {view.roleChoices.map((role) => (
            <button key={role} className="primary" onClick={() => setSearchParams({ as: role })}>
              {ROLE_LABELS[role]}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const message = outcomeMessage(view);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="card-title">{view.businessUnit.name}</div>
          <h1>
            Kit {view.kit.number} · {view.kit.testTypeName}
          </h1>
          <p className="mono">
            {view.kit.serial} · {view.order.orderNumber}
            {view.order.externalFulfillmentId ? ` · REF ${view.order.externalFulfillmentId}` : ''}
          </p>
        </div>
        <StatusBadge status={view.kit.status} kind="kit" />
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {view.caughtUp.length > 0 ? (
        <Alert tone="info">
          Steps nobody had recorded were filled in from this scan:{' '}
          {view.caughtUp.map((status) => KIT_STATUS_LABELS[status]).join(', ')}.
        </Alert>
      ) : null}
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      <div className="grid cols-2">
        <div className="card stack">
          <div>
            <div className="card-title">What you can do</div>
            {view.actions.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                {view.outcome === 'none'
                  ? 'Nothing is required from you for this kit right now.'
                  : 'That was all this scan needed to do.'}
              </p>
            ) : (
              <div className="stack">
                {view.actions.map((action) => (
                  <button
                    key={action.id}
                    className="primary"
                    disabled={perform.isPending}
                    onClick={() => perform.mutate(action.path)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="spread small">
            <span className="muted">Order status</span>
            <StatusBadge status={view.order.status} />
          </div>
          <div className="spread small">
            <span className="muted">Package</span>
            <span>{view.order.packageName}</span>
          </div>
          {view.order.patientName ? (
            <div className="spread small">
              <span className="muted">Patient</span>
              <span>{view.order.patientName}</span>
            </div>
          ) : null}

          {view.orderPath ? (
            <Link className="btn small" to={view.orderPath}>
              {view.role === 'lab' ? 'Open order to upload results' : 'Open full order'}
            </Link>
          ) : null}
        </div>

        {view.labReturnLabel ? (
          <div className="card">
            <div className="card-title">Return label — mail your sample here</div>
            <h3>{view.labReturnLabel.labName}</h3>
            <AddressBlock address={view.labReturnLabel.address} />
            <div className="small muted" style={{ marginTop: 10 }}>
              Reference <span className="mono">{view.labReturnLabel.reference}</span>. This label
              ships inside your kit; the address is already filled in for you.
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** `/scan` with no code: the place a sticker's "can't scan?" line sends people. */
export function ScanEntry() {
  return (
    <div className="card stack" style={{ maxWidth: 520 }}>
      <div className="card-title">Kit serial</div>
      <h2 style={{ margin: 0 }}>Enter the serial from your kit</h2>
      <p className="small muted" style={{ margin: 0 }}>
        It is printed under the QR code, like QK-7F3K-9M2P. Entering it does exactly what scanning
        the code would: patients register the kit as received, and the lab checks it in.
      </p>
      <KitSerialEntry />
    </div>
  );
}
