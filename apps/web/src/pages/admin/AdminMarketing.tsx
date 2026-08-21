import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { Loading, Alert, Field } from '../../components/ui';

interface PageVersion {
  id: string;
  version: number;
  title: string;
  headline: string | null;
  bodyHtml: string;
  isPublished: boolean;
  createdAt: string;
}

const STARTER_HTML = `<section>
  <h2>Know your numbers</h2>
  <p>Order a kit, mail your sample, and get results you can act on.</p>
  <ul>
    <li>At-home collection</li>
    <li>Certified laboratory analysis</li>
  </ul>
</section>`;

export function AdminMarketing() {
  const { slug = '' } = useParams();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [headline, setHeadline] = useState('');
  const [bodyHtml, setBodyHtml] = useState(STARTER_HTML);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', slug, 'marketing'],
    queryFn: () =>
      api<{ versions: PageVersion[]; published: PageVersion | null }>(
        `/api/bu/${slug}/marketing-page`,
      ),
  });

  useEffect(() => {
    const current = data?.published ?? data?.versions[0];
    if (current) {
      setTitle(current.title);
      setHeadline(current.headline ?? '');
      setBodyHtml(current.bodyHtml);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (publish: boolean) =>
      api(`/api/bu/${slug}/marketing-page`, {
        method: 'PUT',
        body: { title, headline: headline || undefined, bodyHtml, publish },
      }),
    onSuccess: (_result, publish) => {
      setIsError(false);
      setMessage(publish ? 'Published. Your storefront is live.' : 'Draft version saved.');
      void queryClient.invalidateQueries({ queryKey: ['admin', slug, 'marketing'] });
    },
    onError: (err: Error) => {
      setIsError(true);
      setMessage(err.message);
    },
  });

  if (isLoading) return <Loading what="marketing page" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Marketing page</h1>
          <p>
            Controls the look of <Link to={`/${slug}`}>/{slug}</Link>. Every save creates a new
            version, so publishing is just a pointer move.
          </p>
        </div>
      </div>

      <Alert tone={isError ? 'error' : 'success'}>{message}</Alert>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">Editor</div>
          <Field label="Page title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Headline">
            <input value={headline} onChange={(e) => setHeadline(e.target.value)} />
          </Field>
          <Field label="Body HTML">
            <textarea
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              style={{ minHeight: 260, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 }}
            />
          </Field>
          <div className="row">
            <button onClick={() => save.mutate(false)} disabled={!title || save.isPending}>
              Save draft
            </button>
            <button
              className="primary"
              onClick={() => save.mutate(true)}
              disabled={!title || save.isPending}
            >
              Save and publish
            </button>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-title">Preview</div>
            <h2>{headline || title}</h2>
            <div className="marketing-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
          </div>

          <div className="card">
            <div className="card-title">Versions</div>
            {(data?.versions.length ?? 0) === 0 ? (
              <p className="small muted">Nothing saved yet.</p>
            ) : (
              data!.versions.map((version) => (
                <div key={version.id} className="spread small" style={{ marginBottom: 6 }}>
                  <span>
                    v{version.version} · {version.title}
                  </span>
                  <span>
                    {version.isPublished ? <span className="badge success">live</span> : null}{' '}
                    <span className="muted">{date(version.createdAt)}</span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
