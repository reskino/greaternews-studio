import { useEffect, useState } from 'react';

/** The page is wide enough for the sticky right rail (matches `.gn-layout`'s 1180px breakpoint). */
export const RAIL_QUERY = '(min-width: 1181px)';

function matches(query: string) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/** True while the CSS media query matches; updates when the viewport crosses it. */
export function useMediaQuery(query: string) {
  const [isMatch, setIsMatch] = useState(() => matches(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const list = window.matchMedia(query);
    const update = () => setIsMatch(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return isMatch;
}
