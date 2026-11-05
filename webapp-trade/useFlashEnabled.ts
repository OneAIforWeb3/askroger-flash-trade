import { useQuery } from '@tanstack/react-query';
import { getTradeStatus } from './trade.service';

/** Button stays hidden when the build flag is off or the server has no Flash key. */
export const useFlashEnabled = () => {
  const flagOn = import.meta.env.VITE_FLASH_TRADING !== '0';
  const { data } = useQuery({
    queryKey: ['trade-status'],
    queryFn: getTradeStatus,
    enabled: flagOn,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return { enabled: flagOn && !!data?.enabled, feeBps: data?.integratorFeeBps ?? '0' };
};
