import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { date } from '../lib/format';

interface Notification {
  id: string;
  title: string;
  body: string;
  linkPath: string | null;
  readAt: string | null;
  createdAt: string;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: Notification[]; unreadCount: number }>('/api/notifications'),
    refetchInterval: 20_000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api(`/api/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markAll = useMutation({
    mutationFn: () => api('/api/notifications/read-all', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const unread = data?.unreadCount ?? 0;

  return (
    <div className="bell-wrap">
      <button className="small" onClick={() => setOpen((v) => !v)} aria-label="Notifications">
        Alerts
        {unread > 0 ? <span className="bell-count">{unread}</span> : null}
      </button>

      {open ? (
        <div className="notif-list">
          <div className="spread" style={{ padding: '4px 8px 8px' }}>
            <strong className="small">Notifications</strong>
            {unread > 0 ? (
              <button className="small" onClick={() => markAll.mutate()}>
                Mark all read
              </button>
            ) : null}
          </div>

          {(data?.notifications.length ?? 0) === 0 ? (
            <div className="small muted" style={{ padding: 12 }}>
              Nothing yet.
            </div>
          ) : (
            data!.notifications.map((notification) => (
              <div
                key={notification.id}
                className={`notif ${notification.readAt ? '' : 'unread'}`}
                onClick={() => {
                  if (!notification.readAt) markRead.mutate(notification.id);
                  if (notification.linkPath) {
                    setOpen(false);
                    navigate(notification.linkPath);
                  }
                }}
              >
                <div className="small" style={{ fontWeight: 600 }}>
                  {notification.title}
                </div>
                <div className="small muted">{notification.body}</div>
                <div className="when small muted">{date(notification.createdAt)}</div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
