/**
 * The one behaviour that justifies useEscape being a stack rather than a
 * listener: with dialogs nested (DuplicateModal → ConfirmStep), Escape must
 * close the TOP one only, then the next. A regression here is invisible in
 * manual testing until someone happens to press Escape mid-confirm and loses
 * both layers.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useEscape } from './useEscape';

function Layer({ onDismiss }: { onDismiss: () => void }) {
  useEscape(onDismiss);
  return null;
}

const pressEscape = () =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

describe('useEscape', () => {
  it('dismisses on Escape and nothing else', () => {
    const close = vi.fn();
    const { unmount } = render(<Layer onDismiss={close} />);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(close).not.toHaveBeenCalled();
    pressEscape();
    expect(close).toHaveBeenCalledTimes(1);
    unmount();
    pressEscape();
    expect(close).toHaveBeenCalledTimes(1); // unmounted surfaces stop listening
  });

  it('only the top of the stack hears Escape; the next layer takes over on unmount', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const shell = render(<Layer onDismiss={outer} />);
    const confirm = render(<Layer onDismiss={inner} />);

    pressEscape();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    confirm.unmount();
    pressEscape();
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
    shell.unmount();
  });

  it('reads the latest handler, not the one from first render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Layer onDismiss={first} />);
    view.rerender(<Layer onDismiss={second} />);
    pressEscape();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('a disabled entry is not in the stack — it neither fires nor shadows the layer below', () => {
    const Gated = ({ onDismiss, open }: { onDismiss: () => void; open: boolean }) => {
      useEscape(onDismiss, open);
      return null;
    };
    const below = vi.fn();
    const viewer = vi.fn();
    const shell = render(<Layer onDismiss={below} />);
    const gated = render(<Gated onDismiss={viewer} open={false} />);

    pressEscape(); // closed viewer must not swallow the key from the layer below
    expect(viewer).not.toHaveBeenCalled();
    expect(below).toHaveBeenCalledTimes(1);

    gated.rerender(<Gated onDismiss={viewer} open />);
    pressEscape();
    expect(viewer).toHaveBeenCalledTimes(1);
    expect(below).toHaveBeenCalledTimes(1);

    gated.rerender(<Gated onDismiss={viewer} open={false} />);
    pressEscape();
    expect(viewer).toHaveBeenCalledTimes(1);
    expect(below).toHaveBeenCalledTimes(2);
    gated.unmount();
    shell.unmount();
  });
});
