import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, fetchBlobUrl } from '../../lib/api';
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
  };
  kits: Array<{ id: string; kitNumber: number; testTypeName: string; status: string }>;
  results: Array<{
    id: string;
    fileId: string | null;
    filename: string | null;
    sizeBytes: number | null;
    summary: string | null;
  }>;
  review: {
    decision: string | null;
    interpretation: string | null;
    aiDraft: string | null;
    aiModel: string | null;
    decidedAt: string | null;
  } | null;
  events: TimelineEvent[];
}

export function DoctorReview() {
  const { orderId = '' } = useParams();
  const { me } = useAuth();
  const navigate = useNavigate();

  const slug = me?.memberships.find((m) => m.role === 'doctor')?.businessUnitSlug;
  const base = `/api/bu/${slug}/doctor/reviews/${orderId}`;

  const [interpretation, setInterpretation] = useState('');
  const [recommendations, setRecommendations] = useState('');
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['doctor', 'review', orderId],
    queryFn: () => api<Detail>(base),
    enabled: Boolean(slug),
  });

  const submit = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') =>
      api(base, {
        method: 'POST',
        body: { decision, interpretation, recommendations: recommendations || undefined },
      }),
    onSuccess: () => navigate('/portal/doctor'),
    onError: (err: Error) => setError(err.message),
  });

  if (isLoading || !data) return <Loading what="review" />;

  const alreadyDecided = Boolean(data.review?.decidedAt);

  return (
    <>
      <div className="page-header">
        <div>
          <Link to="/portal/doctor" className="small muted">
            ← Review queue
          </Link>
          <h1 style={{ marginTop: 8 }}>{data.order.patientName}</h1>
          <p className="mono">
            {data.order.orderNumber} · {data.order.packageName}
          </p>
        </div>
        <StatusBadge status={data.order.status} />
      </div>

      <Alert tone="error">{error}</Alert>
      {alreadyDecided ? <Alert tone="info">This order has already been reviewed.</Alert> : null}

      <div className="grid cols-2">
        <div className="stack">
          <div className="card">
            <div className="card-title">Lab results</div>
            {data.results.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                No result files attached.
              </p>
            ) : (
              data.results.map((result) => (
                <div key={result.id} className="stack" style={{ marginBottom: 12 }}>
                  {result.fileId ? (
                    <button
                      onClick={async () => {
                        const url = await fetchBlobUrl(`${base}/results/${result.fileId}`);
                        window.open(url, '_blank', 'noopener');
                      }}
                    >
                      Open {result.filename} ({bytes(result.sizeBytes ?? 0)})
                    </button>
                  ) : null}
                  {result.summary ? (
                    <div className="small">
                      <strong>Technician summary:</strong> <span className="muted">{result.summary}</span>
                    </div>
                  ) : null}
                </div>
              ))
            )}

            <div className="card-title" style={{ marginTop: 16 }}>
              Panels
            </div>
            {data.kits.map((kit) => (
              <div key={kit.id} className="spread small" style={{ marginBottom: 5 }}>
                <span>
                  #{kit.kitNumber} {kit.testTypeName}
                </span>
                <StatusBadge status={kit.status} kind="kit" />
              </div>
            ))}
          </div>

          {data.review?.aiDraft ? (
            <div className="card">
              <div className="spread">
                <div className="card-title" style={{ margin: 0 }}>
                  AI draft
                </div>
                <span className="pill">{data.review.aiModel}</span>
              </div>
              <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>
                {data.review.aiDraft}
              </p>
              <button
                className="small"
                disabled={alreadyDecided}
                onClick={() => setInterpretation(data.review!.aiDraft!)}
              >
                Copy into my interpretation
              </button>
            </div>
          ) : null}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-title">Your interpretation</div>
            <p className="small muted">
              Read against the package focus
              {data.order.packageFocusArea ? `: ${data.order.packageFocusArea}` : ''}. Both a yes and
              a no are sent to the patient with your explanation.
            </p>

            <Field label="Interpretation">
              <textarea
                value={interpretation}
                onChange={(event) => setInterpretation(event.target.value)}
                disabled={alreadyDecided}
                placeholder="What the results show and what it means for this patient."
              />
            </Field>

            <Field
              label="Recommendations"
              hint="If you reject, explain which markers need to improve and how."
            >
              <textarea
                value={recommendations}
                onChange={(event) => setRecommendations(event.target.value)}
                disabled={alreadyDecided}
              />
            </Field>

            <div className="row">
              <button
                className="primary"
                disabled={alreadyDecided || !interpretation || submit.isPending}
                onClick={() => submit.mutate('approved')}
              >
                Approve plan
              </button>
              <button
                className="danger"
                disabled={alreadyDecided || !interpretation || submit.isPending}
                onClick={() => submit.mutate('rejected')}
              >
                Reject with recommendations
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-title">History</div>
            <Timeline events={data.events} />
            {data.review?.decidedAt ? (
              <div className="small muted">Decided {date(data.review.decidedAt)}</div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
