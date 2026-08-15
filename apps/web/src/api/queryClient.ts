import { QueryClient } from '@tanstack/react-query';
import { NtProblemError } from '@neoting/contracts';

/**
 * One query client for the app.
 *
 * The retry rule is the part worth deciding deliberately. The contract's error
 * codes are stable and meaningful, so a 401, a 403 or a 404 is an answer, not a
 * hiccup — retrying them three times delays telling the person something true.
 * A 429 or a 5xx is worth another go, and the API sends RateLimit-Reset for
 * exactly that reason.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Documents change when someone uploads or approves, not on a timer, so
      // the cache is trusted for a minute rather than refetched on every mount.
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof NtProblemError) {
          if (error.status === 429 || error.status >= 500) return failureCount < 2;
          return false;
        }
        // A network fault with no response at all — worth one more attempt.
        return failureCount < 1;
      },
    },
    mutations: {
      // Never automatic. Every mutation carries an Idempotency-Key, so a replay
      // is safe on the server, but a silent retry of an approval is a decision
      // the person did not make twice.
      retry: false,
    },
  },
});
