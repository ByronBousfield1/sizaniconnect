import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

/** Loads data on mount and whenever `deps` change; `reload` re-runs it after a mutation. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, tick]);

  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}

/** Runs a mutation, tracking busy state and turning failures into a displayable ApiError. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection.'));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}
