import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTokenOrdersSummary } from './trade.service';
import { normalizeChain } from './chains';
import { shareOnXUrl } from './share';

interface Props {
  chain?: string | null;
  tokenId?: string | null;
  tokenSymbol?: string | null;
}

/** Quiet caption under the Flash pill: how many askRoger users traded this token through Flash. */
const FlashOrdersLine: React.FC<Props> = ({ chain, tokenId, tokenSymbol }) => {
  const flashChain = normalizeChain(chain);
  const { data } = useQuery({
    queryKey: ['trade-token-orders', flashChain, tokenId],
    queryFn: () => getTokenOrdersSummary(flashChain as string, tokenId as string),
    enabled: !!flashChain && !!tokenId,
    staleTime: 30 * 1000,
    retry: false,
  });
  if (!data || !data.count) return null;
  const orders = `${data.count} Flash order${data.count === 1 ? '' : 's'}`;
  const traders = `${data.traders} askRoger trader${data.traders === 1 ? '' : 's'}`;
  return (
    <div className="flash-orders-line">
      <span className="flash-orders-line__dot" aria-hidden="true" />
      <span className="flash-orders-line__text">
        {orders} by {traders}
      </span>
      <a
        href={shareOnXUrl(tokenSymbol, data.traders, window.location.href)}
        target="_blank"
        rel="noopener noreferrer"
        className="flash-orders-line__share">
        Share on X
      </a>
    </div>
  );
};

export default FlashOrdersLine;
