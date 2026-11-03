import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BrandHeader } from '../components/BrandHeader';
import { clearHandoff, readHandoff, safeReturnLink } from '../lib/handoff';

/**
 * Where a guest lands after Stripe. Deliberately names no order, package, or patient: the shopper
 * has no session, and the only next step is the email the platform sends once payment clears.
 */
export function GuestThanks() {
  const { slug = '' } = useParams();
  // Read once, then forget: the handoff has done its job and should not outlive this page.
  const [backLink] = useState(() => safeReturnLink(readHandoff(slug)?.returnUrl));
  useEffect(() => clearHandoff(slug), [slug]);

  return (
    <div className="centered">
      <div className="auth-card">
        <BrandHeader />
        <h1>Thank you</h1>
        <p>
          Once your payment is confirmed we’ll email you a link to activate your account. You’ll use
          it to track your kit and read your results.
        </p>
        <p className="muted small">
          Didn’t get an email within a few minutes? Check your spam folder, or contact the clinic
          that sold you the kit.
        </p>
        {backLink && (
          // Plain link to the tenant's own site: nothing about the purchase is appended.
          <a className="btn primary" href={backLink.href} rel="noreferrer">
            Back to {backLink.host}
          </a>
        )}
        <Link className="btn" to={`/${slug}`} style={{ marginLeft: backLink ? 8 : 0 }}>
          Back to storefront
        </Link>
      </div>
    </div>
  );
}
