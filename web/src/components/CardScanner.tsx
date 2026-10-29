import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type Decoder = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => Promise<string | null>;

const SCAN_EVERY_MS = 250; // four looks a second is enough, and leaves a cheap phone's CPU for the rest of the page
const DECODE_WIDTH = 480; // frames are shrunk before decoding; a card filling the guide box still has plenty of pixels
const GIVE_UP_AFTER_MS = 20_000;

/**
 * The browser's own QR reader (BarcodeDetector, built into Chrome on Android) is fast and costs
 * nothing to download. Where it is missing, a small JavaScript decoder is fetched only at that
 * moment, so nobody downloads it unless they need it.
 */
async function createDecoder(): Promise<Decoder> {
  const Native = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): DetectorLike; getSupportedFormats?: () => Promise<string[]> } })
    .BarcodeDetector;
  const formats: string[] = Native ? ((await Native.getSupportedFormats?.().catch(() => [] as string[])) ?? []) : [];
  if (Native && formats.includes('qr_code')) {
    const detector = new Native({ formats: ['qr_code'] });
    return async (canvas) => (await detector.detect(canvas))[0]?.rawValue ?? null;
  }
  const { default: jsQR } = await import('jsqr');
  return async (canvas, ctx) => {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

function cameraProblem(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission was refused. Type the reference code instead, or allow the camera for this site in the browser settings.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device. Type the reference code instead.';
  if (name === 'NotReadableError') return 'The camera is being used by another app. Close it and try again, or type the reference code.';
  return 'The camera could not be started. Type the reference code instead.';
}

/**
 * Camera scanning for household cards. `onScan` receives everything that is read; it returns null
 * when the scan was accepted (the scanner then closes), or a message explaining why it was refused
 * (shown while scanning carries on).
 */
export function CardScanner({ onScan, onClose }: { onScan: (raw: string) => string | null; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'starting' | 'scanning' | 'stopped'>('starting');
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let cancelled = false;
    let lastRejected = '';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const stop = () => {
      cancelled = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      document.removeEventListener('visibilitychange', onHidden);
    };
    const onHidden = () => {
      if (document.hidden) {
        stop();
        setState('stopped');
        setMessage('Scanning stopped because the screen was switched away.');
      }
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia || !ctx) {
        setState('stopped');
        setMessage('This browser cannot use the camera. Type the reference code instead.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 20 } },
        });
      } catch (err) {
        setState('stopped');
        setMessage(cameraProblem(err));
        return;
      }
      if (cancelled) return stop();
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      const decode = await createDecoder().catch(() => null);
      if (!decode) {
        stop();
        setState('stopped');
        setMessage('The card reader could not be loaded. Check the connection, or type the reference code.');
        return;
      }
      setState('scanning');
      document.addEventListener('visibilitychange', onHidden);
      const startedAt = Date.now();

      const tick = async () => {
        if (cancelled) return;
        if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
          stop();
          setState('stopped');
          setMessage('No card could be read. Hold the card flat, in good light, about a hand’s length from the camera, or type the code printed on it.');
          return;
        }
        if (video.readyState >= 2 && video.videoWidth) {
          const scale = Math.min(1, DECODE_WIDTH / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const raw = await decode(canvas, ctx).catch(() => null);
          if (raw && raw !== lastRejected && !cancelled) {
            const problem = onScanRef.current(raw);
            if (problem === null) {
              stop();
              return;
            }
            lastRejected = raw; // the same bad card held still is reported once, not four times a second
            setMessage(problem);
          }
        }
        timer = window.setTimeout(() => void tick(), SCAN_EVERY_MS);
      };
      void tick();
    })();

    return stop;
  }, [attempt]);

  return (
    <div className="scanner" role="region" aria-label="Card scanner">
      <div className="scanner-view">
        <video ref={videoRef} muted playsInline aria-hidden="true" />
        {state === 'scanning' ? <div className="scanner-guide" aria-hidden="true" /> : null}
      </div>
      <p className="scanner-status" aria-live="polite">
        {state === 'starting' ? 'Starting the camera…' : state === 'scanning' && !message ? 'Point the camera at the QR code on the household card.' : message}
      </p>
      <div className="form-actions">
        {state === 'stopped' ? (
          <Button kind="quiet" onClick={() => {
              setMessage(null);
              setState('starting');
              setAttempt((a) => a + 1);
            }}>
            Try the camera again
          </Button>
        ) : null}
        <Button kind="quiet" onClick={onClose}>
          {state === 'stopped' ? 'Close' : 'Stop scanning'}
        </Button>
      </div>
    </div>
  );
}
