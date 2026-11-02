import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { initialParams, useTaxEstimate, type EstimateParams } from '../../api/taxEstimate';
import { TaxEstimatePanel } from './TaxEstimatePanel';

/**
 * The client page's Tax estimate tab (D52). Lazy from `ClientDetailView`, so
 * neither this nor the generated estimate client rides that route's opening
 * download. The add-on is the client's to buy; the accountant can only read.
 */

const m = defineMessages({
  inactiveTitle: { id: 'taxEstimate.client.inactiveTitle', defaultMessage: 'This client has not added the tax estimate' },
  inactiveBody: {
    id: 'taxEstimate.client.inactiveBody',
    defaultMessage:
      'It shows what their VAT or GST return and their company tax are likely to come to, from the documents and bank statements already here, with a range and a completeness score. The client adds it themselves from their portal (Settings → Plan) for £15 a month plus VAT, or A$30 a month for an Australian business. It goes on their own bill.',
  },
});

export function ClientTaxEstimate({ businessId, name }: { businessId: string; name: string }) {
  const intl = useIntl();
  const [params, setParams] = useState<EstimateParams>(() => initialParams());
  const query = useTaxEstimate(businessId, params);
  return (
    <TaxEstimatePanel
      country={query.data?.estimate?.country ?? 'GB'}
      view={query.data}
      loading={query.isPending}
      error={query.error}
      params={params}
      onParams={setParams}
      subject={name}
      inactive={
        <div className="rounded-2xl border border-white/10 bg-card p-5">
          <h3 className="text-[15px] font-semibold text-white">{intl.formatMessage(m.inactiveTitle)}</h3>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-300">{intl.formatMessage(m.inactiveBody)}</p>
        </div>
      }
    />
  );
}
