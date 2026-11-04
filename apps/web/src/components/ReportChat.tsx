import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_AI_DISCLAIMER } from '@nio/shared';
import { api, ApiError } from '../lib/api';
import { date } from '../lib/format';
import { Alert, Field } from './ui';

interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

/** Saved conversations about one released order; the open thread lives in `?thread=`. */
export function ReportChat({ base, orderId }: { base: string; orderId: string }) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const threadId = searchParams.get('thread');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [outOfCredits, setOutOfCredits] = useState(false);

  const threadsKey = ['patient', 'threads', orderId];
  const threads = useQuery({
    queryKey: threadsKey,
    queryFn: () =>
      api<{
        enabled: boolean;
        disclaimer: string;
        credits: { exhausted: boolean };
        threads: ThreadSummary[];
      }>(`${base}/threads`),
  });

  const thread = useQuery({
    queryKey: ['patient', 'thread', orderId, threadId],
    queryFn: () => api<{ messages: ThreadMessage[] }>(`${base}/threads/${threadId}`),
    enabled: Boolean(threadId),
  });

  function openThread(id: string | null) {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('thread', id);
    else next.delete('thread');
    setSearchParams(next, { replace: true });
    setError('');
  }

  const ask = useMutation({
    mutationFn: () =>
      threadId
        ? api<{ threadId: string }>(`${base}/threads/${threadId}/messages`, {
            method: 'POST',
            body: { prompt },
          })
        : api<{ threadId: string }>(`${base}/threads`, { method: 'POST', body: { prompt } }),
    onSuccess: (result) => {
      setPrompt('');
      setError('');
      if (result.threadId !== threadId) openThread(result.threadId);
      void queryClient.invalidateQueries({ queryKey: threadsKey });
      void queryClient.invalidateQueries({ queryKey: ['patient', 'thread', orderId, result.threadId] });
    },
    onError: (err: Error) => {
      if (err instanceof ApiError && err.code === 'OUT_OF_CREDITS') {
        setError('');
        void queryClient.invalidateQueries({ queryKey: threadsKey });
        setOutOfCredits(true);
        return;
      }
      setError(err.message);
    },
  });

  const archive = useMutation({
    mutationFn: (id: string) => api(`${base}/threads/${id}`, { method: 'DELETE' }),
    onSuccess: (_result, id) => {
      if (id === threadId) openThread(null);
      void queryClient.invalidateQueries({ queryKey: threadsKey });
    },
    onError: (err: Error) => setError(err.message),
  });

  const messages = threadId ? (thread.data?.messages ?? []) : [];
  const logRef = useRef<HTMLDivElement>(null);
  const lastMessageId = messages.at(-1)?.id;
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [threadId, lastMessageId]);

  if (!threads.data?.enabled) {
    return (
      <p className="small muted" style={{ margin: 0 }}>
        {threads.isLoading ? 'Loading…' : 'Report discussion is not configured yet.'}
      </p>
    );
  }

  const disclaimer = threads.data.disclaimer || DEFAULT_AI_DISCLAIMER;
  const list = threads.data.threads;

  return (
    <>
      <div className="spread" style={{ marginBottom: 10 }}>
        <span className="small muted">
          {list.length === 0 ? 'No conversations yet.' : `${list.length} saved conversation${list.length === 1 ? '' : 's'}`}
        </span>
        <button className="small" onClick={() => openThread(null)} disabled={!threadId}>
          New conversation
        </button>
      </div>

      {list.length > 0 ? (
        <div className="thread-list">
          {list.map((item) => (
            <div key={item.id} className={`thread-item${item.id === threadId ? ' active' : ''}`}>
              <button className="thread-open" onClick={() => openThread(item.id)}>
                <span className="thread-title">{item.title}</span>
                <span className="small muted">
                  {date(item.updatedAt)} · {Math.ceil(item.messageCount / 2)} question
                  {item.messageCount === 2 ? '' : 's'}
                </span>
              </button>
              <button
                className="small"
                title="Remove from your list"
                aria-label={`Remove conversation ${item.title}`}
                disabled={archive.isPending}
                onClick={() => archive.mutate(item.id)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {threadId && thread.isLoading ? <p className="small muted">Loading conversation…</p> : null}
      {messages.length > 0 ? (
        <div className="chat-log" ref={logRef}>
          {messages.map((message) => (
            <div key={message.id} className={`chat-message ${message.role}`}>
              <strong className="small">{message.role === 'user' ? 'You' : 'Assistant'}</strong>
              {message.role === 'assistant' ? (
                <>
                  <div className="chat-markdown small">
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ node: _node, ...props }) => (
                          <a {...props} target="_blank" rel="noopener noreferrer" />
                        ),
                      }}
                    >
                      {message.content}
                    </Markdown>
                  </div>
                  <p className="small muted" style={{ margin: '6px 0 0' }}>
                    {disclaimer}
                  </p>
                </>
              ) : (
                <p className="small" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>
                  {message.content}
                </p>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <Alert tone="error">{error}</Alert>
      {outOfCredits || threads.data.credits.exhausted ? (
        <p className="small muted" style={{ margin: 0 }}>
          You've used the AI allowance included with this report. Your saved conversations stay
          available above.
        </p>
      ) : (
        <>
          <Field label={threadId ? 'Ask a follow-up' : 'Start a new conversation about this report'}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="What does this marker mean?"
            />
          </Field>
          <button
            className="primary"
            onClick={() => ask.mutate()}
            disabled={!prompt.trim() || ask.isPending}
          >
            {ask.isPending ? 'Thinking…' : 'Send'}
          </button>
        </>
      )}
    </>
  );
}
