import { ORDER_STATUS_LABELS, KIT_STATUS_LABELS, type OrderStatus, type KitStatus } from '@nio/shared';

export function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function date(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status as OrderStatus] ?? status;
}

export function kitStatusLabel(status: string): string {
  return KIT_STATUS_LABELS[status as KitStatus] ?? status;
}

/** Groups statuses into the four visual tones the badges use. */
export function statusTone(status: string): 'pending' | 'active' | 'success' | 'danger' {
  if (status === 'cancelled' || status === 'clinician_rejected' || status === 'problem') return 'danger';
  if (status === 'results_released' || status === 'clinician_approved' || status === 'lab_complete') {
    return 'success';
  }
  if (status === 'pending_payment' || status === 'awaiting_fulfillment') return 'pending';
  return 'active';
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
