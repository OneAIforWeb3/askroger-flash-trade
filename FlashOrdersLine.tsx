import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTokenOrdersSummary } from './trade.service';
import { normalizeChain } from './chains';

interface Props {
  chain?: string | null;
  tokenId?: string | null;
  tokenSymbol?: string | null;
}

/** Public social line under the Flash button: how many askRoger users traded this token through Flash. */
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
  const text = `${data.count} Flash order${data.count === 1 ? '' : 's'} by ${data.traders} askRoger trader${
    data.traders === 1 ? '' : 's'
  } on this token`;
  const shareText = encodeURIComponent(
    `$${tokenSymbol || ''} is trending on askRoger and ${data.traders} trader${data.traders === 1 ? '' : 's'} already acted on it with @DefinitiveFi Flash. Trade the signal:`,
  );
  const shareUrl = encodeURIComponent(window.location.href);
  return (
    <div className="flash-orders-line">
      <span>{text}</span>
      <a
        href={`https://x.com/intent/post?text=${shareText}&url=${shareUrl}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flash-share">
        Share on X
      </a>
    </div>
  );
};

export default FlashOrdersLine;
