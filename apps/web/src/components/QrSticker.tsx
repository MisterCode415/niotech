import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

interface Props {
  value: string;
  orderNumber: string;
  externalOrderId: string | null;
  kitNumber: number;
  testTypeName: string;
}

/**
 * The physical sticker applied to a kit. It carries our order number and the fulfillment
 * partner's own id in human-readable form, plus the scannable token that every later role uses.
 */
export function QrSticker({ value, orderNumber, externalOrderId, kitNumber, testTypeName }: Props) {
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
      <div className="kit-name">
        Kit {kitNumber} · {testTypeName}
      </div>
      <div className="label">Qinio {orderNumber}</div>
      <div className="label">REF {externalOrderId ?? '—'}</div>
    </div>
  );
}
