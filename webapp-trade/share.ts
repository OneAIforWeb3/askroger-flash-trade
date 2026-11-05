/** Share-to-X intent links for the token page caption and the drawer. */
export const shareOnXUrl = (tokenSymbol: string | null | undefined, traders: number, pageUrl: string): string => {
  const who = traders === 1 ? '1 trader has' : `${traders} traders have`;
  const text = encodeURIComponent(
    `$${tokenSymbol || ''} is trending on askRoger and ${who} already acted on it with @DefinitiveFi Flash. Trade the signal:`,
  );
  return `https://x.com/intent/post?text=${text}&url=${encodeURIComponent(pageUrl)}`;
};
