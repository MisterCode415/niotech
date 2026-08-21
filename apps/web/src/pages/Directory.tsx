import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Loading, Empty } from '../components/ui';

export function Directory() {
  const { data, isLoading } = useQuery({
    queryKey: ['public', 'business-units'],
    queryFn: () =>
      api<{ businessUnits: Array<{ name: string; slug: string }> }>('/api/public/business-units'),
  });

  return (
    <div className="page">
      <div className="hero">
        <h1>
          NIO<span style={{ color: 'var(--accent)' }}>Tech</span> storefronts
        </h1>
        <p className="muted">
          Every business unit runs its own storefront, packages and clinical roster on shared
          infrastructure.
        </p>
        <Link to="/login" className="btn primary">
          Sign in to a portal
        </Link>
      </div>

      {isLoading ? (
        <Loading what="storefronts" />
      ) : (data?.businessUnits.length ?? 0) === 0 ? (
        <Empty>No active business units yet.</Empty>
      ) : (
        <div className="grid cols-3">
          {data!.businessUnits.map((businessUnit) => (
            <Link key={businessUnit.slug} to={`/${businessUnit.slug}`} className="card">
              <div className="card-title">Storefront</div>
              <h3>{businessUnit.name}</h3>
              <p className="muted small mono">/{businessUnit.slug}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
