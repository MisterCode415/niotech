import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { normalizeKitSerial } from '@nio/shared';

/**
 * Manual fallback for a QR code that will not scan: typing the serial printed under it lands on
 * exactly the same page, and triggers exactly the same step, as the scan would have.
 */
export function KitSerialEntry({ buttonLabel = 'Continue' }: { buttonLabel?: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  return (
    <form
      className="row"
      style={{ gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}
      onSubmit={(event) => {
        event.preventDefault();
        const serial = normalizeKitSerial(value);
        if (!serial) {
          setError(
            'That does not look like a kit serial. It is printed under the QR code as QK-XXXX-XXXX.',
          );
          return;
        }
        setError('');
        navigate(`/scan/${serial}`);
      }}
    >
      <div style={{ flex: '1 1 180px' }}>
        <input
          className="mono"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="QK-XXXX-XXXX"
          aria-label="Kit serial"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          required
        />
        {error ? (
          <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>
            {error}
          </div>
        ) : null}
      </div>
      <button className="primary" type="submit">
        {buttonLabel}
      </button>
    </form>
  );
}
