import { useEffect, useState } from 'react';
import { getConnection, onConnectionChange, type ConnectionState } from '../lib/api';

/**
 * Tells people at once when the connection is gone, instead of leaving them to find out from a
 * failed save. It clears itself as soon as a request gets through again.
 */
export function ConnectionBanner() {
  const [state, setState] = useState<ConnectionState>(getConnection());
  const [checking, setChecking] = useState(false);
  useEffect(() => onConnectionChange(setState), []);
  if (state === 'online') return null;

  const check = async () => {
    setChecking(true);
    try {
      await fetch('/api/v1/health', { cache: 'no-store' }).then((r) => {
        if (r.ok) window.dispatchEvent(new Event('online'));
      });
    } catch {
      /* still unreachable; the banner stays */
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="connection-banner" role="status">
      <p>
        {state === 'offline'
          ? 'You are offline. Nothing can be saved until your phone has signal or Wi-Fi again.'
          : "SizaniConnect can't be reached right now. Nothing new is being saved."}
      </p>
      <button type="button" className="link-button" onClick={() => void check()} disabled={checking}>
        {checking ? 'Checking…' : 'Check again'}
      </button>
    </div>
  );
}
