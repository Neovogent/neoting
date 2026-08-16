import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';
import { AppProvider } from './context/AppContext';
import { ConfirmProvider } from './components/DynamicComponents/ConfirmProvider';
import { queryClient } from './api/queryClient';
import { AppIntlProvider } from './i18n/AppIntlProvider';

/**
 * The mocked API starts before React does.
 *
 * Awaiting the worker matters: a query that fires while the service worker is
 * still registering goes to the network, 404s against the dev server, and the
 * screen shows an error for a request that would have been answered a
 * millisecond later.
 */
async function bootstrap() {
  if (import.meta.env.VITE_API_MOCKING === 'enabled') {
    const { startMockApi } = await import('./api/mocks/browser');
    await startMockApi();
  }

  createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outermost, above AppProvider: the context reads seed data that already
        carries copy, and a confirm dialog is text before it is anything else,
        so both need `useIntl()` available. Nothing above this needs messages. */}
    <AppIntlProvider>
    <QueryClientProvider client={queryClient}>
    <AppProvider>
      {/* Outside App so the dialog covers every shell — practice, business
          portal, and the two SMS links. */}
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </AppProvider>
    </QueryClientProvider>
    </AppIntlProvider>
  </StrictMode>,
  );
}

void bootstrap();
