import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/**
 * Draws a QR code as one SVG path (no images, no HTML strings), so it prints sharply at any size
 * and needs nothing outside the page. Error correction level M survives a crease or a smudge
 * covering about 15% of the code.
 */
export function QrCode({ value, size = 200, label }: { value: string; size?: number; label: string }) {
  const { d, n } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Alphanumeric');
    qr.make();
    const count = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    }
    return { d: path, n: count + 8 }; // 4-module quiet zone on every side
  }, [value]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
