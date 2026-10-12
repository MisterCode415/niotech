import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Alert, Field, Loading } from '../../components/ui';

export function AdminAi() {
  const { slug = '' } = useParams();
  const queryClient = useQueryClient();
  const [railsPrompt, setRailsPrompt] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const settings = useQuery({
    queryKey: ['admin', slug, 'ai'],
    queryFn: async () => {
      const data = await api<{ settings: { railsPrompt: string } }>(`/api/bu/${slug}/ai`);
      setRailsPrompt(data.settings.railsPrompt);
      return data;
    },
  });

  const save = useMutation({
    mutationFn: () => api(`/api/bu/${slug}/ai`, { method: 'PUT', body: { railsPrompt } }),
    onSuccess: () => {
      setError('');
      setMessage('Report discussion rails saved.');
      void queryClient.invalidateQueries({ queryKey: ['admin', slug, 'ai'] });
    },
    onError: (err: Error) => {
      setMessage('');
      setError(err.message);
    },
  });

  if (settings.isLoading) return <Loading what="AI settings" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Report discussion rails</h1>
          <p>
            These dos and don&apos;ts are included when a patient talks about their released report.
            Platform safety rules still override them.
          </p>
        </div>
      </div>
      <Alert tone="success">{message}</Alert>
      <Alert tone="error">{error}</Alert>
      <div className="card">
        <Field
          label="Business rails"
          hint="Examples: approved next steps, topics to avoid, how to refer back to a clinician."
        >
          <textarea
            value={railsPrompt}
            onChange={(event) => setRailsPrompt(event.target.value)}
            rows={12}
          />
        </Field>
        <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </button>
      </div>
    </>
  );
}
