import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_AI_DISCLAIMER } from '@nio/shared';
import { api } from '../../lib/api';
import { Alert, Field, Loading } from '../../components/ui';

interface Provider {
  id: string;
  name: string;
  apiUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  model: string;
  customHeaders: Array<{ name: string; value: string }>;
  inputTokenCostPerMillion: number;
  outputTokenCostPerMillion: number;
  maxOutputTokens: number;
  sortOrder: number;
  enabled: boolean;
  phiApproved: boolean;
  phiApprovedAt: string | null;
  phiApprovalNote: string | null;
}

interface FormState {
  name: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  customHeaders: Array<{ name: string; value: string }>;
  inputTokenCostPerMillion: number;
  outputTokenCostPerMillion: number;
  maxOutputTokens: number;
  enabled: boolean;
  phiApproved: boolean;
  phiApprovalNote: string;
}

const emptyForm = (): FormState => ({
  name: '',
  apiUrl: '',
  apiKey: '',
  model: '',
  customHeaders: [{ name: '', value: '' }],
  inputTokenCostPerMillion: 0,
  outputTokenCostPerMillion: 0,
  maxOutputTokens: 1024,
  enabled: true,
  phiApproved: false,
  phiApprovalNote: '',
});

export function PlatformAi() {
  const queryClient = useQueryClient();
  const [railsPrompt, setRailsPrompt] = useState('');
  const [disclaimer, setDisclaimer] = useState(DEFAULT_AI_DISCLAIMER);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const config = useQuery({
    queryKey: ['platform', 'ai'],
    queryFn: async () => {
      const data = await api<{
        settings: { railsPrompt: string; disclaimer: string };
        providers: Provider[];
      }>('/api/platform/ai');
      setRailsPrompt(data.settings.railsPrompt);
      setDisclaimer(data.settings.disclaimer);
      return data;
    },
  });

  function ok(text: string) {
    setError('');
    setMessage(text);
    void queryClient.invalidateQueries({ queryKey: ['platform', 'ai'] });
  }

  const saveSettings = useMutation({
    mutationFn: () =>
      api('/api/platform/ai/settings', { method: 'PUT', body: { railsPrompt, disclaimer } }),
    onSuccess: () => ok('Platform rails saved.'),
    onError: (err: Error) => setError(err.message),
  });

  const saveProvider = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        customHeaders: form.customHeaders.filter((header) => header.name.trim()),
        apiKey: form.apiKey || undefined,
      };
      return editingId
        ? api(`/api/platform/ai/providers/${editingId}`, { method: 'PUT', body })
        : api('/api/platform/ai/providers', { method: 'POST', body });
    },
    onSuccess: () => {
      setForm(emptyForm());
      setEditingId(null);
      ok(editingId ? 'Provider updated.' : 'Provider added.');
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/platform/ai/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => ok('Provider removed.'),
    onError: (err: Error) => setError(err.message),
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      api('/api/platform/ai/providers/order', { method: 'PUT', body: { orderedIds } }),
    onSuccess: () => ok('Failover order updated.'),
    onError: (err: Error) => setError(err.message),
  });

  if (config.isLoading) return <Loading what="AI configuration" />;

  const providers = config.data?.providers ?? [];

  function move(index: number, direction: -1 | 1) {
    const next = [...providers];
    const swap = index + direction;
    if (swap < 0 || swap >= next.length) return;
    const current = next[index]!;
    next[index] = next[swap]!;
    next[swap] = current;
    reorder.mutate(next.map((provider) => provider.id));
  }

  return (
    <>
      <div className="page-header">
        <div>
          <Link to="/portal/platform" className="small muted">
            ← Platform
          </Link>
          <h1 style={{ marginTop: 8 }}>Report AI</h1>
          <p>
            Platform rails are injected last and override tenant prompts. Providers are tried in
            order when the previous one fails.
          </p>
        </div>
      </div>

      <Alert tone="success">{message}</Alert>
      <Alert tone="error">{error}</Alert>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Platform rails</div>
        <Field label="Rails prompt">
          <textarea
            value={railsPrompt}
            onChange={(event) => setRailsPrompt(event.target.value)}
            rows={8}
          />
        </Field>
        <Field label="Disclaimer shown under every AI reply">
          <textarea
            value={disclaimer}
            onChange={(event) => setDisclaimer(event.target.value)}
            rows={3}
          />
        </Field>
        <button className="primary" onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>
          Save rails
        </button>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">LLM providers</div>
        {providers.length === 0 ? (
          <p className="small muted">No providers yet. Chat stays disabled until one is enabled.</p>
        ) : (
          <div className="stack">
            {providers.map((provider, index) => (
              <div key={provider.id} className="spread">
                <div>
                  <strong>{provider.name}</strong>
                  <div className="small muted mono">
                    {provider.model} · {provider.apiUrl}
                  </div>
                  <div className="small muted">
                    {provider.enabled ? 'Enabled' : 'Disabled'} · key {provider.apiKeyMasked || 'missing'}
                  </div>
                  <div className="small muted">
                    {provider.phiApproved
                      ? `Approved for PHI${
                          provider.phiApprovedAt
                            ? ` since ${new Date(provider.phiApprovedAt).toLocaleDateString()}`
                            : ''
                        }${provider.phiApprovalNote ? ` · ${provider.phiApprovalNote}` : ''}`
                      : 'Not approved for PHI: skipped by production chat'}
                  </div>
                </div>
                <div className="row">
                  <button onClick={() => move(index, -1)} disabled={index === 0}>
                    Up
                  </button>
                  <button onClick={() => move(index, 1)} disabled={index === providers.length - 1}>
                    Down
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(provider.id);
                      setForm({
                        name: provider.name,
                        apiUrl: provider.apiUrl,
                        apiKey: '',
                        model: provider.model,
                        customHeaders:
                          provider.customHeaders.length > 0
                            ? provider.customHeaders
                            : [{ name: '', value: '' }],
                        inputTokenCostPerMillion: provider.inputTokenCostPerMillion,
                        outputTokenCostPerMillion: provider.outputTokenCostPerMillion,
                        maxOutputTokens: provider.maxOutputTokens,
                        enabled: provider.enabled,
                        phiApproved: provider.phiApproved,
                        phiApprovalNote: provider.phiApprovalNote ?? '',
                      });
                    }}
                  >
                    Edit
                  </button>
                  <button className="danger" onClick={() => remove.mutate(provider.id)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">{editingId ? 'Edit provider' : 'Add provider'}</div>
        <Field label="Name">
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="API URL">
          <input
            value={form.apiUrl}
            onChange={(event) => setForm({ ...form, apiUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </Field>
        <Field label="Model">
          <input
            value={form.model}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
            placeholder="gpt-4o-mini"
          />
        </Field>
        <Field label={editingId ? 'API key (leave blank to keep current)' : 'API key'}>
          <input
            type="password"
            value={form.apiKey}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
          />
        </Field>
        <div className="field-row">
          <Field label="Input $ / 1M tokens">
            <input
              type="number"
              value={form.inputTokenCostPerMillion}
              onChange={(event) =>
                setForm({ ...form, inputTokenCostPerMillion: Number(event.target.value) })
              }
            />
          </Field>
          <Field label="Output $ / 1M tokens">
            <input
              type="number"
              value={form.outputTokenCostPerMillion}
              onChange={(event) =>
                setForm({ ...form, outputTokenCostPerMillion: Number(event.target.value) })
              }
            />
          </Field>
          <Field label="Max output tokens">
            <input
              type="number"
              value={form.maxOutputTokens}
              onChange={(event) => setForm({ ...form, maxOutputTokens: Number(event.target.value) })}
            />
          </Field>
        </div>
        <Field label="Custom headers">
          <div className="stack">
            {form.customHeaders.map((header, index) => (
              <div key={index} className="row">
                <input
                  placeholder="Header name"
                  value={header.name}
                  onChange={(event) => {
                    const customHeaders = [...form.customHeaders];
                    customHeaders[index] = { ...header, name: event.target.value };
                    setForm({ ...form, customHeaders });
                  }}
                />
                <input
                  placeholder="Value"
                  value={header.value}
                  onChange={(event) => {
                    const customHeaders = [...form.customHeaders];
                    customHeaders[index] = { ...header, value: event.target.value };
                    setForm({ ...form, customHeaders });
                  }}
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setForm({ ...form, customHeaders: [...form.customHeaders, { name: '', value: '' }] })
              }
            >
              Add header
            </button>
          </div>
        </Field>
        <label className="small">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          />{' '}
          Enabled
        </label>
        <div style={{ marginTop: 12 }}>
          <label className="small">
            <input
              type="checkbox"
              checked={form.phiApproved}
              onChange={(event) => setForm({ ...form, phiApproved: event.target.checked })}
            />{' '}
            Approved for PHI (BAA on file)
          </label>
          <p className="small muted" style={{ margin: '4px 0 8px' }}>
            In production, report chat only sends report text and patient questions to providers
            with this box checked. Only check it once a signed BAA covers this vendor and model.
          </p>
          <Field label="BAA reference (agreement name, date, or ticket)">
            <input
              value={form.phiApprovalNote}
              maxLength={500}
              onChange={(event) => setForm({ ...form, phiApprovalNote: event.target.value })}
            />
          </Field>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary"
            onClick={() => saveProvider.mutate()}
            disabled={saveProvider.isPending || !form.name || !form.apiUrl || !form.model}
          >
            {editingId ? 'Update provider' : 'Add provider'}
          </button>
          {editingId ? (
            <button
              onClick={() => {
                setEditingId(null);
                setForm(emptyForm());
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
