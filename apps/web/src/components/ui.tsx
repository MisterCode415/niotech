import type { ReactNode } from 'react';
import { orderStatusLabel, kitStatusLabel, statusTone, date } from '../lib/format';

export function StatusBadge({ status, kind = 'order' }: { status: string; kind?: 'order' | 'kit' }) {
  const label = kind === 'kit' ? kitStatusLabel(status) : orderStatusLabel(status);
  return <span className={`badge ${statusTone(status)}`}>{label}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Alert({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'error' | 'success';
  children: ReactNode;
}) {
  if (!children) return null;
  return <div className={`alert ${tone}`}>{children}</div>;
}

export function Loading({ what = 'data' }: { what?: string }) {
  return <div className="empty">Loading {what}…</div>;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="small muted" style={{ marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="card">
      <div className="card-title">{label}</div>
      <div className="stat">{value}</div>
    </div>
  );
}

export interface TimelineEvent {
  id: string;
  message: string;
  actorRole: string;
  actorName: string | null;
  toStatus: string | null;
  createdAt: string;
}

/** The audit trail, rendered exactly as stored: one entry per recorded transition. */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) return <Empty>No activity recorded yet.</Empty>;

  return (
    <ul className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <div className="spread" style={{ alignItems: 'flex-start' }}>
            <div>
              <div>{event.message}</div>
              <div className="when">
                {event.actorName ?? event.actorRole} · {date(event.createdAt)}
              </div>
            </div>
            {event.toStatus ? <StatusBadge status={event.toStatus} /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AddressBlock({
  address,
}: {
  address: {
    line1: string;
    line2?: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
  } | null;
}) {
  if (!address) return <span className="muted">No address on file</span>;
  return (
    <address className="address">
      {address.line1}
      <br />
      {address.line2 ? (
        <>
          {address.line2}
          <br />
        </>
      ) : null}
      {address.city}, {address.region} {address.postalCode}
      <br />
      {address.country}
    </address>
  );
}
