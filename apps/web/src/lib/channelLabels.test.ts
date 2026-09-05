import { createIntl } from 'react-intl';
import { defineMessages } from 'react-intl';
import { describe, expect, it } from 'vitest';

import { channelLabels, receivedViaHeading, receivedViaText, submitterDisplay } from './channelLabels';

/**
 * The one catalogue for a document row's "how it arrived" words (item 21): the
 * slugs never render, ID's no-SMS rule holds, and the practice's own manual
 * door names the person (item 62) while client channels name the channel.
 */

const intl = createIntl({ locale: 'en-GB' });
const m = defineMessages({ via: { id: 'test.via', defaultMessage: 'via {source}' } });

describe('submitterDisplay', () => {
  it('renders human words and swallows every provenance slug', () => {
    expect(submitterDisplay({ submitterLabel: 'Uploaded by Priya Shah' })).toBe('Uploaded by Priya Shah');
    expect(submitterDisplay({ submitterLabel: 'uploaded-by-delegated-session' })).toBeNull();
    expect(submitterDisplay({ submitterLabel: 'uploaded-via-chase-link' })).toBeNull();
    expect(submitterDisplay({ submitterLabel: 'uploaded-via-client-portal' })).toBeNull();
    expect(submitterDisplay({})).toBeNull();
  });
});

describe('receivedViaText — the cell', () => {
  it('client channels name the CHANNEL; the manual door names the PERSON', () => {
    expect(receivedViaText(intl, { source: 'portal' })).toBe('Client portal');
    expect(receivedViaText(intl, { source: 'sms-link' })).toBe('Chase link');
    expect(receivedViaText(intl, { source: 'chat' })).toBe('Chat upload');
    expect(receivedViaText(intl, { source: 'web', submitterLabel: 'Uploaded by Priya Shah' })).toBe(
      'Uploaded by Priya Shah',
    );
    // A legacy manual row with no label keeps the generic channel word.
    expect(receivedViaText(intl, { source: 'web' })).toBe('Web upload');
    // A portal member's label belongs to the preview's provenance line, not
    // the cell — the cell says the door (item 21's exact words).
    expect(receivedViaText(intl, { source: 'portal', submitterLabel: 'Captured by M (Z)' })).toBe('Client portal');
  });

  it('never says SMS anywhere — ID sends none (launch M8)', () => {
    for (const descriptor of Object.values(channelLabels)) {
      expect(String(descriptor.defaultMessage)).not.toMatch(/sms/i);
    }
  });
});

describe('receivedViaHeading — the preview header', () => {
  it('channels compose into "via {source}"; a named manual upload stands alone', () => {
    expect(receivedViaHeading(intl, { source: 'portal' }, m.via)).toBe('via Client portal');
    expect(receivedViaHeading(intl, { source: 'sms-link' }, m.via)).toBe('via Chase link');
    // Never "via Uploaded by …" — the label IS the sentence.
    expect(receivedViaHeading(intl, { source: 'web', submitterLabel: 'Uploaded by Priya Shah' }, m.via)).toBe(
      'Uploaded by Priya Shah',
    );
  });
});
