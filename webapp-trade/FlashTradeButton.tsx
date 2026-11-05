import React from 'react';
import { TokenDataItem } from '@customTypes/cashtag.types';
import { useTradeStore } from './useTradeStore';
import { useFlashEnabled } from './useFlashEnabled';
import { isFlashTradable } from './chains';

interface Props {
  item: TokenDataItem;
  /** Icon-only pill for table rows; the default is the labelled pill for the token page. */
  compact?: boolean;
}

/**
 * The single entry point into the Flash drawer. Renders nothing unless the server
 * reports Flash enabled and the row's chain is one we can trade on (EVM, known to
 * Flash, with a verified USDC address). Safe to drop into any row or card.
 */
const FlashTradeButton: React.FC<Props> = ({ item, compact = false }) => {
  const { enabled } = useFlashEnabled();
  const openDrawer = useTradeStore(s => s.openDrawer);
  if (!enabled || !isFlashTradable(item?.chain, item?.is_coin)) return null;
  return (
    <button
      type="button"
      className={`exchange-pill flash-pill ${compact ? 'flash-pill--compact' : ''}`}
      title="Trade with Flash by Definitive"
      aria-label="Trade with Flash"
      onClick={e => {
        e.stopPropagation();
        e.preventDefault();
        openDrawer(item);
      }}>
      <span aria-hidden="true">⚡</span>
      {!compact && <span>Trade with Flash</span>}
    </button>
  );
};

export default FlashTradeButton;
