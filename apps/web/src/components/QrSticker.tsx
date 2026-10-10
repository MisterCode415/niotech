import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

interface Props {
  value: string;
  serial: string;
  orderNumber: string;
  externalOrderId: string | null;
  kitNumber: number;
  testTypeName: string;
}

/**
 * The physical sticker applied to a kit. It carries our order number and the fulfillment
 * partner's own id in human-readable form, plus the scannable token that every later role uses.
 * The serial beneath the code is the fallback when a camera cannot read it.
 */
export function QrSticker({
  value,
  serial,
  orderNumber,
  externalOrderId,
  kitNumber,
  testTypeName,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    void QRCode.toCanvas(canvasRef.current, value, {
      width: 150,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    });
  }, [value]);

  return (
    <div className="sticker">
      <canvas ref={canvasRef} />
      <div className="serial">{serial}</div>
      <div className="kit-name">
        Kit {kitNumber} · {testTypeName}
      </div>
      <div className="label">Qinio {orderNumber}</div>
      <div className="label">REF {externalOrderId ?? '—'}</div>
      <div className="hint">
        Can't scan? Visit {window.location.host}/scan and enter the serial.
      </div>
    </div>
  );
}
