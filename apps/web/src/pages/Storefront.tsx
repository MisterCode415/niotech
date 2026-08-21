import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { Loading, Empty } from '../components/ui';
import { useAuth } from '../lib/auth';

interface PackageRow {
  id: string;
  name: string;
  description: string | null;
  focusArea: string | null;
  priceCents: number;
  requiresClinician: boolean;
  kitCount: number;
  tests: Array<{ name: string; description: string | null; quantity: number; turnaroundDays: number }>;
}

export function Storefront() {
  const { slug = '' } = useParams();
  const { me } = useAuth();

  const page = useQuery({
    queryKey: ['public', slug, 'page'],
    queryFn: () =>
      api<{
        businessUnit: { name: string };
        page: { title: string; headline: string | null; bodyHtml: string } | null;
      }>(`/api/public/${slug}/page`),
  });

  const catalog = useQuery({
    queryKey: ['public', slug, 'packages'],
    queryFn: () =>
      api<{ businessUnit: { name: string }; packages: PackageRow[] }>(
        `/api/public/${slug}/packages`,
      ),
  });

  if (page.isLoading || catalog.isLoading) return <div className="page"><Loading what="storefront" /></div>;
  if (page.isError) return <div className="page"><Empty>This storefront is not available.</Empty></div>;

  const businessUnit = catalog.data?.businessUnit ?? page.data?.businessUnit;
  const isPatientHere = me?.memberships.some(
    (m) => m.businessUnitSlug === slug && m.role === 'patient',
  );

  return (
    <div className="page">
      <div className="hero">
        <div className="spread" style={{ marginBottom: 18 }}>
          <Link to="/" className="small muted">
            ← All storefronts
          </Link>
          {me ? (
            <Link to="/portal" className="btn small">
              My portal
            </Link>
          ) : (
            <Link to="/login" className="btn small">
              Sign in
            </Link>
          )}
        </div>

        <h1>{page.data?.page?.headline ?? businessUnit?.name ?? 'Testing packages'}</h1>
        {page.data?.page ? (
          <div
            className="marketing-body"
            // The business unit controls this HTML from their own template editor.
            dangerouslySetInnerHTML={{ __html: page.data.page.bodyHtml }}
          />
        ) : (
          <p className="muted">This business unit has not published a page yet.</p>
        )}
      </div>

      <h2>Packages</h2>
      {(catalog.data?.packages.length ?? 0) === 0 ? (
        <Empty>No packages are on sale right now.</Empty>
      ) : (
        <div className="grid cols-3">
          {catalog.data!.packages.map((pkg) => (
            <div key={pkg.id} className="card stack">
              <div>
                <div className="card-title">{pkg.focusArea ?? 'General'}</div>
                <h3>{pkg.name}</h3>
                <p className="muted small">{pkg.description}</p>
              </div>

              <div>
                {pkg.tests.map((test) => (
                  <div key={test.name} className="small" style={{ marginBottom: 4 }}>
                    <span className="pill">×{test.quantity}</span> {test.name}{' '}
                    <span className="muted">· {test.turnaroundDays}d turnaround</span>
                  </div>
                ))}
              </div>

              <div className="small">
                {pkg.requiresClinician ? (
                  <span className="badge active">Doctor reviewed</span>
                ) : (
                  <span className="badge pending">Results direct to you</span>
                )}
              </div>

              <div className="spread">
                <div className="price">{money(pkg.priceCents)}</div>
                {isPatientHere ? (
                  <Link className="btn primary" to={`/${slug}/checkout/${pkg.id}`}>
                    Order kit
                  </Link>
                ) : (
                  <Link className="btn" to={`/${slug}/register?package=${pkg.id}`}>
                    Register to order
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
