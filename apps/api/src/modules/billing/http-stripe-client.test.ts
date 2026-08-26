import { expect, test } from 'vitest';

import { encodeForm, HttpStripeClient, type HttpStripeConfig, STRIPE_API_VERSION } from './http-stripe-client.js';

const CONFIG: HttpStripeConfig = {
  secretKey: 'rk_test_not_a_real_key',
  priceId: 'price_neo_accounting',
  taxMode: 'rate',
  taxRateId: 'txr_gb_vat_20',
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

function harness(config: Partial<HttpStripeConfig> = {}, response: unknown = { id: 'cus_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: new URLSearchParams(init.body) });
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(response),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, client: new HttpStripeClient({ ...CONFIG, ...config }, fetchImpl) };
}

test('nested parameters are encoded the way Stripe expects, not as JSON', () => {
  // Stripe IGNORES a parameter it does not recognise, so a mis-encoded
  // `default_tax_rates` does not error — it charges the net price with no VAT.
  const encoded = new URLSearchParams(
    encodeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1 }],
      metadata: { businessId: 'biz_1' },
      subscription_data: { default_tax_rates: ['txr_1'] },
    }),
  );
  expect(encoded.get('mode')).toBe('subscription');
  expect(encoded.get('line_items[0][price]')).toBe('price_1');
  expect(encoded.get('line_items[0][quantity]')).toBe('1');
  expect(encoded.get('metadata[businessId]')).toBe('biz_1');
  expect(encoded.get('subscription_data[default_tax_rates][0]')).toBe('txr_1');
});

test('null and undefined are omitted rather than sent as the strings "null"/"undefined"', () => {
  const encoded = new URLSearchParams(encodeForm({ a: null, b: undefined, c: 'kept' }));
  expect(encoded.has('a')).toBe(false);
  expect(encoded.has('b')).toBe(false);
  expect(encoded.get('c')).toBe('kept');
});

test('the API version is pinned on every request', async () => {
  const { calls, client } = harness();
  await client.createCustomer({ businessId: 'biz_1', practiceId: 'prac_1', name: 'Cleaners Ltd', email: null, idempotencyKey: 'k1' });
  expect(calls[0]?.headers['Stripe-Version']).toBe(STRIPE_API_VERSION);
  expect(calls[0]?.headers['Idempotency-Key']).toBe('k1');
});

test('the customer carries both tenant ids, and omits practiceId rather than sending it empty', async () => {
  const { calls, client } = harness();
  await client.createCustomer({ businessId: 'biz_1', practiceId: 'prac_1', name: 'Cleaners Ltd', email: 'a@b.example', idempotencyKey: 'k' });
  expect(calls[0]?.body.get('metadata[businessId]')).toBe('biz_1');
  expect(calls[0]?.body.get('metadata[practiceId]')).toBe('prac_1');
  expect(calls[0]?.body.get('email')).toBe('a@b.example');

  const standalone = harness();
  await standalone.client.createCustomer({ businessId: 'biz_2', practiceId: null, name: 'Solo Ltd', email: null, idempotencyKey: 'k' });
  // Absent, not ''. A handler comparing '' against "absent" is one `!==` away
  // from opening a scope on a practice called nothing.
  expect(standalone.calls[0]?.body.has('metadata[practiceId]')).toBe(false);
  expect(standalone.calls[0]?.body.has('email')).toBe(false);
});

test('checkout is hosted subscription mode with the one price and no payment_method_types', async () => {
  const { calls, client } = harness();
  await client.createCheckoutSession({
    customerId: 'cus_1',
    businessId: 'biz_1',
    practiceId: 'prac_1',
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/no',
    idempotencyKey: 'k',
  });
  const body = calls[0]!.body;
  expect(body.get('mode')).toBe('subscription');
  expect(body.get('customer')).toBe('cus_1');
  expect(body.get('line_items[0][price]')).toBe('price_neo_accounting');
  expect(body.get('line_items[0][quantity]')).toBe('1');
  // Hardcoding ['card'] would lock out every other method forever, and Stripe
  // cannot then be configured from its own dashboard.
  expect([...body.keys()].some((key) => key.startsWith('payment_method_types'))).toBe(false);
});

test('checkout collects a billing address and writes it back — the VAT prerequisites', async () => {
  const { calls, client } = harness();
  await client.createCheckoutSession({
    customerId: 'cus_1',
    businessId: 'biz_1',
    practiceId: 'prac_1',
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/no',
    idempotencyKey: 'k',
  });
  const body = calls[0]!.body;
  // The customer already exists, so without these Stripe reuses an address it
  // does not have — and an unresolvable location is what makes a tax
  // calculation quietly return zero.
  expect(body.get('billing_address_collection')).toBe('required');
  expect(body.get('customer_update[address]')).toBe('auto');
  expect(body.get('tax_id_collection[enabled]')).toBe('true');
});

test('STRIPE_TAX=rate attaches the explicit GB rate and does NOT enable automatic tax', async () => {
  const { calls, client } = harness({ taxMode: 'rate' });
  await client.createCheckoutSession({
    customerId: 'cus_1',
    businessId: 'biz_1',
    practiceId: 'prac_1',
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/no',
    idempotencyKey: 'k',
  });
  const body = calls[0]!.body;
  expect(body.get('subscription_data[default_tax_rates][0]')).toBe('txr_gb_vat_20');
  // Stripe REJECTS a request carrying both.
  expect(body.has('automatic_tax[enabled]')).toBe(false);
  // …and the tax params must not have eaten the metadata beside them.
  expect(body.get('subscription_data[metadata][businessId]')).toBe('biz_1');
});

test('STRIPE_TAX=automatic enables Stripe Tax and sends no manual rate', async () => {
  const { calls, client } = harness({ taxMode: 'automatic' });
  await client.createCheckoutSession({
    customerId: 'cus_1',
    businessId: 'biz_1',
    practiceId: 'prac_1',
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/no',
    idempotencyKey: 'k',
  });
  const body = calls[0]!.body;
  expect(body.get('automatic_tax[enabled]')).toBe('true');
  expect(body.has('subscription_data[default_tax_rates][0]')).toBe(false);
  expect(body.get('subscription_data[metadata][businessId]')).toBe('biz_1');
});

test('the tenant ids reach BOTH the session and the subscription it creates', async () => {
  const { calls, client } = harness();
  await client.createCheckoutSession({
    customerId: 'cus_1',
    businessId: 'biz_1',
    practiceId: 'prac_1',
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/no',
    idempotencyKey: 'k',
  });
  const body = calls[0]!.body;
  // `checkout.session.completed` carries the SESSION's metadata and nothing of
  // the subscription's, so both are needed.
  expect(body.get('client_reference_id')).toBe('biz_1');
  expect(body.get('metadata[practiceId]')).toBe('prac_1');
  expect(body.get('subscription_data[metadata][practiceId]')).toBe('prac_1');
});

test('expires_at becomes a UTC instant, and its absence becomes null', async () => {
  const withExpiry = harness({}, { url: 'https://checkout.stripe.com/c/pay/cs_1', expires_at: 1_772_086_400 });
  const session = await withExpiry.client.createCheckoutSession({
    customerId: 'cus_1',
    businessId: 'biz_1',
    practiceId: 'prac_1',
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/no',
    idempotencyKey: 'k',
  });
  expect(session.expiresAt).toBe(new Date(1_772_086_400 * 1000).toISOString());

  const portal = harness({}, { url: 'https://billing.stripe.com/p/session/x' });
  expect((await portal.client.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.example/', idempotencyKey: 'k' })).expiresAt).toBeNull();
});

test('a Stripe failure becomes our own 500 and leaks nothing from their body', async () => {
  const fetchImpl = (async () =>
    ({
      ok: false,
      status: 402,
      headers: new Headers({ 'request-id': 'req_123' }),
      text: async () =>
        JSON.stringify({ error: { type: 'card_error', code: 'card_declined', message: 'The card 4242… was declined.' } }),
    }) as unknown as Response) as unknown as typeof fetch;
  const client = new HttpStripeClient(CONFIG, fetchImpl);

  await expect(
    client.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.example/', idempotencyKey: 'k' }),
  ).rejects.toMatchObject({ code: 'NT-SRV-001' });

  try {
    await client.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.example/', idempotencyKey: 'k' });
  } catch (error) {
    // Stripe's message is written for a dashboard and can quote submitted
    // values back. Error responses are screenshotted far more freely than
    // request bodies are.
    expect(JSON.stringify(error)).not.toContain('4242');
  }
});

test('a 200 with an unparseable body is a failure, not a silent success', async () => {
  const fetchImpl = (async () =>
    ({ ok: true, status: 200, headers: new Headers(), text: async () => '<html>maintenance</html>' }) as unknown as Response) as unknown as typeof fetch;
  const client = new HttpStripeClient(CONFIG, fetchImpl);
  await expect(
    client.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.example/', idempotencyKey: 'k' }),
  ).rejects.toMatchObject({ code: 'NT-SRV-001' });
});
