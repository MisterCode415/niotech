import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { date, bytes } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import {
  Loading,
  StatusBadge,
  Timeline,
  Alert,
  Field,
  type TimelineEvent,
} from '../../components/ui';

interface Detail {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    packageName: string;
    packageFocusArea: string | null;
    patientName: string;
    requiresClinician: boolean;
  };
  kits: Array<{ id: string; kitNumber: number; status: string; testTypeName: string; sampleType: string }>;
  events: TimelineEvent[];
  results: Array<{ id: string; kitId: string; filename: string | null; sizeBytes: number | null; completedAt: string | null }>;
}

export function LabOrder() {
  const { orderId = '' } = useParams();
  const { me } = useAuth();
  const queryClient = useQueryClient();

  const slug = me?.memberships.find((m) => m.role === 'lab')?.businessUnitSlug;
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState('');
  const [uploadedFileId, setUploadedFileId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['lab', 'order', orderId],
    queryFn: () => api<Detail>(`/api/bu/${slug}/lab/orders/${orderId}`),
    enabled: Boolean(slug),
  });

  function fail(err: Error) {
    setIsError(true);
    setMessage(err.message);
  }

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a PDF first');
      const body = new FormData();
      body.append('file', file);
      return api<{ file: { id: string } }>(`/api/bu/${slug}/lab/orders/${orderId}/files`, {
        method: 'POST',
        body,
      });
    },
    onSuccess: (result) => {
      setIsError(false);
      setUploadedFileId(result.file.id);
      setMessage('Results file uploaded. Now mark the kits complete.');
    },
    onError: fail,
  });

  const complete = useMutation({
    mutationFn: (kitId: string) =>
      api<{ routedTo: string | null }>(`/api/bu/${slug}/lab/kits/${kitId}/complete`, {
        method: 'POST',
        body: { fileId: uploadedFileId, summary: summary || undefined },
      }),
    onSuccess: (result) => {
      setIsError(false);
      setMessage(
        result.routedTo === 'doctor'
          ? 'Analysis complete. The order has been queued for clinician review.'
          : result.routedTo === 'patient'
            ? 'Analysis complete. Raw results were released to the patient.'
            : 'Analysis complete for this kit. Waiting on the remaining kits.',
      );
      void queryClient.invalidateQueries({ queryKey: ['lab'] });
    },
    onError: fail,
  });

  if (isLoading || !data) return <Loading what="order" />;

  const onBench = data.kits.filter((k) => ['received_by_lab', 'processing'].includes(k.status));

  return (
    <>
      <div className="page-header">
        <div>
          <Link to="/portal/lab" className="small muted">
            ← Lab queue
          </Link>
          <h1 style={{ marginTop: 8 }}>{data.order.orderNumber}</h1>
          <p>
            {data.order.packageName} · {data.order.patientName}
            {data.order.packageFocusArea ? ` · ${data.order.packageFocusArea}` : ''}
          </p>
        </div>
        <StatusBadge status={data.order.status} />
      </div>

      <Alert tone={isError ? 'error' : 'success'}>{message}</Alert>

      {data.order.requiresClinician ? (
        <Alert tone="info">
          This package involves a clinician. When the last kit is completed the results go to the
          doctor queue, not straight to the patient.
        </Alert>
      ) : (
        <Alert tone="info">
          No clinician is involved. Completing the last kit releases raw results to the patient.
        </Alert>
      )}

      <div className="grid cols-2">
        <div className="card stack">
          <div>
            <div className="card-title">Upload results</div>
            <Field label="Results PDF">
              <input
                type="file"
                accept="application/pdf"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </Field>
            <Field label="Technician summary" hint="Optional. Seeds the clinician's AI draft.">
              <textarea value={summary} onChange={(event) => setSummary(event.target.value)} />
            </Field>
            <button
              className="primary"
              onClick={() => upload.mutate()}
              disabled={!file || upload.isPending}
            >
              {upload.isPending ? 'Uploading…' : 'Upload PDF'}
            </button>
          </div>

          <div>
            <div className="card-title">Mark analysis complete</div>
            {!uploadedFileId ? (
              <p className="small muted" style={{ margin: 0 }}>
                Upload the results file first.
              </p>
            ) : onBench.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                No kits are currently on the bench for this order.
              </p>
            ) : (
              <div className="stack">
                {onBench.map((kit) => (
                  <div key={kit.id} className="kit-card spread">
                    <div>
                      <strong>
                        Kit {kit.kitNumber} · {kit.testTypeName}
                      </strong>
                      <div className="small muted">{kit.sampleType}</div>
                    </div>
                    <button
                      className="primary small"
                      onClick={() => complete.mutate(kit.id)}
                      disabled={complete.isPending}
                    >
                      Complete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-title">Kits</div>
            {data.kits.map((kit) => (
              <div key={kit.id} className="spread small" style={{ marginBottom: 6 }}>
                <span>
                  #{kit.kitNumber} {kit.testTypeName}
                </span>
                <StatusBadge status={kit.status} kind="kit" />
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-title">Uploaded results</div>
            {data.results.filter((r) => r.filename).length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                Nothing uploaded yet.
              </p>
            ) : (
              data.results
                .filter((r) => r.filename)
                .map((result) => (
                  <div key={result.id} className="spread small" style={{ marginBottom: 6 }}>
                    <span className="mono">{result.filename}</span>
                    <span className="muted">
                      {bytes(result.sizeBytes ?? 0)} · {date(result.completedAt)}
                    </span>
                  </div>
                ))
            )}
          </div>

          <div className="card">
            <div className="card-title">History</div>
            <Timeline events={data.events} />
          </div>
        </div>
      </div>
    </>
  );
}
