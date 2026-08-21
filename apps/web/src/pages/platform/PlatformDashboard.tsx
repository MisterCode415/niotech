import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BusinessUnitStatus } from '@nio/shared';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { Loading, Empty, Stat, Alert, Field } from '../../components/ui';

interface BusinessUnitRow {
  id: string;
  name: string;
  slug: string;
  status: BusinessUnitStatus;
  auth0OrgId: string | null;
  createdAt: string;
  memberCount: number;
  orderCount: number;
}

const STATUS_TONE: Record<BusinessUnitStatus, string> = {
  active: 'success',
  suspended: 'pending',
  removed: 'danger',
};

export function PlatformDashboard() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', slug: '', adminEmail: '', adminName: '' });
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  const overview = useQuery({
    queryKey: ['platform', 'overview'],
    queryFn: () =>
      api<{ businessUnits: number; activeBusinessUnits: number; users: number; orders: number }>(
        '/api/platform/overview',
      ),
  });

  const list = useQuery({
    queryKey: ['platform', 'business-units'],
    queryFn: () => api<{ businessUnits: BusinessUnitRow[] }>('/api/platform/business-units'),
  });

  function done(text: string) {
    setIsError(false);
    setMessage(text);
    void queryClient.invalidateQueries({ queryKey: ['platform'] });
  }
  function fail(err: Error) {
    setIsError(true);
    setMessage(err.message);
  }

  const create = useMutation({
    mutationFn: () => api('/api/platform/business-units', { method: 'POST', body: form }),
    onSuccess: () => {
      done(`${form.name} onboarded. ${form.adminEmail} can now finish setup.`);
      setForm({ name: '', slug: '', adminEmail: '', adminName: '' });
    },
    onError: fail,
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: BusinessUnitStatus }) =>
      api(`/api/platform/business-units/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => done('Business unit status updated.'),
    onError: fail,
  });

  if (overview.isLoading || list.isLoading) return <Loading what="platform" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Platform administration</h1>
          <p>
            Onboard business units and control their access. Everything past this point is handled by
            each business unit's own admin.
          </p>
        </div>
      </div>

      <Alert tone={isError ? 'error' : 'success'}>{message}</Alert>

      <div className="grid cols-4" style={{ marginBottom: 22 }}>
        <Stat label="Business units" value={overview.data?.businessUnits ?? 0} />
        <Stat label="Active" value={overview.data?.activeBusinessUnits ?? 0} />
        <Stat label="Users" value={overview.data?.users ?? 0} />
        <Stat label="Orders" value={overview.data?.orders ?? 0} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">Onboard a business unit</div>
          <p className="small muted">
            Creates the tenant, its identity-provider organization, and the first admin account.
          </p>

          <Field label="Company name">
            <input
              value={form.name}
              onChange={(e) =>
                setForm({
                  ...form,
                  name: e.target.value,
                  slug:
                    form.slug ||
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, ''),
                })
              }
            />
          </Field>
          <Field label="Storefront slug" hint="Their public URL will be /{slug}.">
            <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
          </Field>
          <Field label="Primary admin name">
            <input
              value={form.adminName}
              onChange={(e) => setForm({ ...form, adminName: e.target.value })}
            />
          </Field>
          <Field label="Primary admin email">
            <input
              type="email"
              value={form.adminEmail}
              onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
            />
          </Field>

          <button
            className="primary"
            onClick={() => create.mutate()}
            disabled={
              create.isPending || !form.name || !form.slug || !form.adminEmail || !form.adminName
            }
          >
            {create.isPending ? 'Onboarding…' : 'Create business unit'}
          </button>
        </div>

        <div className="card">
          <div className="card-title">Business units</div>
          {(list.data?.businessUnits.length ?? 0) === 0 ? (
            <Empty>No business units yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Members</th>
                  <th>Orders</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data!.businessUnits.map((businessUnit) => (
                  <tr key={businessUnit.id}>
                    <td>
                      {businessUnit.name}
                      <div className="small muted mono">
                        /{businessUnit.slug} · {date(businessUnit.createdAt)}
                      </div>
                    </td>
                    <td>{businessUnit.memberCount}</td>
                    <td>{businessUnit.orderCount}</td>
                    <td>
                      <span className={`badge ${STATUS_TONE[businessUnit.status]}`}>
                        {businessUnit.status}
                      </span>
                    </td>
                    <td>
                      <select
                        value={businessUnit.status}
                        onChange={(event) =>
                          setStatus.mutate({
                            id: businessUnit.id,
                            status: event.target.value as BusinessUnitStatus,
                          })
                        }
                      >
                        <option value="active">Active</option>
                        <option value="suspended">Suspended</option>
                        <option value="removed">Removed</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
