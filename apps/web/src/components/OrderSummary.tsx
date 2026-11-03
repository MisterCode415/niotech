import { money } from '../lib/format';

export interface SummaryPackage {
  name: string;
  priceCents: number;
  requiresClinician: boolean;
  kitCount: number;
}

export function OrderSummary({ pkg }: { pkg: SummaryPackage }) {
  return (
    <div className="card stack">
      <div>
        <div className="card-title">Order summary</div>
        <h3>{pkg.name}</h3>
      </div>
      <div className="spread">
        <span className="muted">Kits included</span>
        <strong>{pkg.kitCount}</strong>
      </div>
      <div className="spread">
        <span className="muted">Clinician review</span>
        <strong>{pkg.requiresClinician ? 'Yes' : 'Not required'}</strong>
      </div>
      <div className="spread" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <span className="muted">Total</span>
        <span className="price">{money(pkg.priceCents)}</span>
      </div>
    </div>
  );
}
