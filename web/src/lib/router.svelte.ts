import { parseHash, type Route } from './route';

export const router = $state<{ route: Route }>({ route: parseHash(globalThis.location?.hash ?? '') });

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    router.route = parseHash(location.hash);
  });
}
