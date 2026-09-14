import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { money } from '../../lib/format';
import { Loading, Empty, Alert, Field } from '../../components/ui';

interface TestType {
  id: string;
  name: string;
  description: string | null;
  sampleType: string;
  turnaroundDays: number;
}

interface PackageRow {
  id: string;
  name: string;
  description: string | null;
  focusArea: string | null;
  internalReference: string | null;
  externalProductId: string | null;
  externalPurchaseUrl: string | null;
  priceCents: number;
  requiresClinician: boolean;
  status: string;
  version: number;
  tests: Array<{ testTypeId: string; quantity: number; name: string }>;
}

export function AdminPackages() {
  const { slug = '' } = useParams();
  const queryClient = useQueryClient();

  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  const [testForm, setTestForm] = useState({
    name: '',
    description: '',
    sampleType: 'blood',
    turnaroundDays: 5,
  });

  const [pkgForm, setPkgForm] = useState({
    name: '',
    description: '',
    focusArea: '',
    internalReference: '',
    externalProductId: '',
    externalPurchaseUrl: '',
    price: '',
    requiresClinician: false,
    status: 'draft',
  });
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);

  const testTypes = useQuery({
    queryKey: ['admin', slug, 'test-types'],
    queryFn: () => api<{ testTypes: TestType[] }>(`/api/bu/${slug}/test-types`),
  });

  const packages = useQuery({
    queryKey: ['admin', slug, 'packages'],
    queryFn: () => api<{ packages: PackageRow[] }>(`/api/bu/${slug}/packages`),
  });

  function done(text: string) {
    setIsError(false);
    setMessage(text);
    void queryClient.invalidateQueries({ queryKey: ['admin', slug] });
  }
  function fail(err: Error) {
    setIsError(true);
    setMessage(err.message);
  }

  const createTestType = useMutation({
    mutationFn: () =>
      api(`/api/bu/${slug}/test-types`, {
        method: 'POST',
        body: { ...testForm, description: testForm.description || undefined },
      }),
    onSuccess: () => {
      done('Test type added.');
      setTestForm({ name: '', description: '', sampleType: 'blood', turnaroundDays: 5 });
    },
    onError: fail,
  });

  const savePackage = useMutation({
    mutationFn: () =>
      api<{ versioned?: boolean }>(`/api/bu/${slug}/packages${editingId ? `/${editingId}` : ''}`, {
        method: editingId ? 'PUT' : 'POST',
        body: {
          name: pkgForm.name,
          description: pkgForm.description || undefined,
          focusArea: pkgForm.focusArea || undefined,
          internalReference: pkgForm.internalReference || undefined,
          externalProductId: pkgForm.externalProductId || undefined,
          externalPurchaseUrl: pkgForm.externalPurchaseUrl || undefined,
          priceCents: Math.round(Number(pkgForm.price) * 100),
          requiresClinician: pkgForm.requiresClinician,
          status: pkgForm.status,
          tests: Object.entries(selected)
            .filter(([, quantity]) => quantity > 0)
            .map(([testTypeId, quantity]) => ({ testTypeId, quantity })),
        },
      }),
    onSuccess: (result: { versioned?: boolean }) => {
      done(
        editingId
          ? result.versioned
            ? 'A new package version was created; the sold version was archived.'
            : 'Package updated.'
          : 'Package created as a draft.',
      );
      setPkgForm({
        name: '',
        description: '',
        focusArea: '',
        internalReference: '',
        externalProductId: '',
        externalPurchaseUrl: '',
        price: '',
        requiresClinician: false,
        status: 'draft',
      });
      setSelected({});
      setEditingId(null);
    },
    onError: fail,
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/api/bu/${slug}/packages/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => done('Package updated.'),
    onError: fail,
  });

  if (testTypes.isLoading || packages.isLoading) return <Loading what="catalog" />;

  const kitTotal = Object.values(selected).reduce((sum, q) => sum + q, 0);

  function editPackage(pkg: PackageRow) {
    setEditingId(pkg.id);
    setPkgForm({
      name: pkg.name,
      description: pkg.description ?? '',
      focusArea: pkg.focusArea ?? '',
      internalReference: pkg.internalReference ?? '',
      externalProductId: pkg.externalProductId ?? '',
      externalPurchaseUrl: pkg.externalPurchaseUrl ?? '',
      price: (pkg.priceCents / 100).toFixed(2),
      requiresClinician: pkg.requiresClinician,
      status: pkg.status === 'archived' ? 'draft' : pkg.status,
    });
    setSelected(Object.fromEntries(pkg.tests.map((test) => [test.testTypeId, test.quantity])));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Packages</h1>
          <p>
            Define the tests you offer, then bundle them. Whether a package involves a doctor is set
            here and drives what happens after the lab finishes.
          </p>
        </div>
      </div>

      <Alert tone={isError ? 'error' : 'success'}>{message}</Alert>

      <div className="grid cols-2" style={{ marginBottom: 22 }}>
        <div className="card">
          <div className="card-title">Add a test type</div>
          <Field label="Name">
            <input
              value={testForm.name}
              onChange={(e) => setTestForm({ ...testForm, name: e.target.value })}
            />
          </Field>
          <Field label="Additional information">
            <textarea
              value={testForm.description}
              onChange={(e) => setTestForm({ ...testForm, description: e.target.value })}
              placeholder="What this panel measures."
            />
          </Field>
          <div className="field-row">
            <Field label="Sample type">
              <input
                value={testForm.sampleType}
                onChange={(e) => setTestForm({ ...testForm, sampleType: e.target.value })}
              />
            </Field>
            <Field label="Turnaround (days)">
              <input
                type="number"
                min={1}
                value={testForm.turnaroundDays}
                onChange={(e) =>
                  setTestForm({ ...testForm, turnaroundDays: Number(e.target.value) })
                }
              />
            </Field>
          </div>
          <button
            className="primary"
            onClick={() => createTestType.mutate()}
            disabled={!testForm.name || createTestType.isPending}
          >
            Add test type
          </button>

          <div className="card-title" style={{ marginTop: 18 }}>
            Existing
          </div>
          {testTypes.data!.testTypes.length === 0 ? (
            <p className="small muted">None yet.</p>
          ) : (
            testTypes.data!.testTypes.map((testType) => (
              <div key={testType.id} className="spread small" style={{ marginBottom: 5 }}>
                <span>{testType.name}</span>
                <span className="muted">
                  {testType.sampleType} · {testType.turnaroundDays}d
                </span>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <div className="card-title">{editingId ? 'Edit package' : 'Create a package'}</div>
          <Field label="Package name">
            <input
              value={pkgForm.name}
              onChange={(e) => setPkgForm({ ...pkgForm, name: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <textarea
              value={pkgForm.description}
              onChange={(e) => setPkgForm({ ...pkgForm, description: e.target.value })}
            />
          </Field>
          <div className="field-row">
            <Field label="Internal SKU / reference">
              <input
                value={pkgForm.internalReference}
                onChange={(e) => setPkgForm({ ...pkgForm, internalReference: e.target.value })}
                placeholder="METABOLIC-01"
              />
            </Field>
            <Field label="External product reference" hint="Stripe, Shopify, or partner product ID.">
              <input
                value={pkgForm.externalProductId}
                onChange={(e) => setPkgForm({ ...pkgForm, externalProductId: e.target.value })}
              />
            </Field>
          </div>
          <Field label="External purchase URL" hint="Leave empty to use Qinio checkout.">
            <input
              type="url"
              value={pkgForm.externalPurchaseUrl}
              onChange={(e) => setPkgForm({ ...pkgForm, externalPurchaseUrl: e.target.value })}
              placeholder="https://store.example.com/products/..."
            />
          </Field>
          <div className="field-row">
            <Field label="Focus area" hint="Shown to the doctor as clinical intent.">
              <input
                value={pkgForm.focusArea}
                onChange={(e) => setPkgForm({ ...pkgForm, focusArea: e.target.value })}
                placeholder="metabolic health"
              />
            </Field>
            <Field label="Price (USD)">
              <input
                type="number"
                min={0}
                step="0.01"
                value={pkgForm.price}
                onChange={(e) => setPkgForm({ ...pkgForm, price: e.target.value })}
              />
            </Field>
          </div>

          <Field label="Tests included">
            {testTypes.data!.testTypes.length === 0 ? (
              <p className="small muted">Add a test type first.</p>
            ) : (
              testTypes.data!.testTypes.map((testType) => (
                <div key={testType.id} className="spread" style={{ marginBottom: 6 }}>
                  <span className="small">{testType.name}</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    style={{ width: 90 }}
                    value={selected[testType.id] ?? 0}
                    onChange={(e) =>
                      setSelected({ ...selected, [testType.id]: Number(e.target.value) })
                    }
                  />
                </div>
              ))
            )}
            <div className="small muted">{kitTotal} kit(s) will ship per order.</div>
          </Field>

          <label className="checkbox" style={{ marginBottom: 14 }}>
            <input
              type="checkbox"
              checked={pkgForm.requiresClinician}
              onChange={(e) => setPkgForm({ ...pkgForm, requiresClinician: e.target.checked })}
            />
            A doctor or clinic interprets these results
          </label>

          <Field label="Lifecycle">
            <select
              value={pkgForm.status}
              onChange={(e) => setPkgForm({ ...pkgForm, status: e.target.value })}
            >
              <option value="draft">Draft</option>
              <option value="active">Active</option>
            </select>
          </Field>

          <button
            className="primary"
            onClick={() => savePackage.mutate()}
            disabled={!pkgForm.name || !pkgForm.price || kitTotal === 0 || savePackage.isPending}
          >
            {editingId ? 'Save package' : 'Create draft'}
          </button>
          {editingId && (
            <button
              style={{ marginLeft: 8 }}
              onClick={() => {
                setEditingId(null);
                setSelected({});
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <h2>Your packages</h2>
      {packages.data!.packages.length === 0 ? (
        <Empty>No packages yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Package</th>
                <th>Tests</th>
                <th>Price</th>
                <th>Clinician</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {packages.data!.packages.map((pkg) => (
                <tr key={pkg.id}>
                  <td>
                    {pkg.name}
                    <div className="small muted">
                      {pkg.focusArea ?? '—'} · v{pkg.version}
                    </div>
                    <div className="small mono">{pkg.internalReference ?? 'No internal reference'}</div>
                  </td>
                  <td className="small">
                    {pkg.tests.map((test) => (
                      <div key={test.testTypeId}>
                        ×{test.quantity} {test.name}
                      </div>
                    ))}
                  </td>
                  <td>{money(pkg.priceCents)}</td>
                  <td>
                    {pkg.requiresClinician ? (
                      <span className="badge active">Required</span>
                    ) : (
                      <span className="badge pending">Direct</span>
                    )}
                  </td>
                  <td>
                    <select
                      value={pkg.status}
                      onChange={(event) =>
                        setStatus.mutate({ id: pkg.id, status: event.target.value })
                      }
                    >
                      <option value="draft">Draft</option>
                      <option value="active">Active</option>
                      <option value="archived">Archived</option>
                    </select>
                  </td>
                  <td>
                    <button className="small" onClick={() => editPackage(pkg)}>
                      Edit
                    </button>
                    {pkg.externalPurchaseUrl && (
                      <a
                        className="btn small"
                        href={pkg.externalPurchaseUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ marginLeft: 6 }}
                      >
                        Store
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
