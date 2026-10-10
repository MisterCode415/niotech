/**
 * Post-login destinations come from the URL, so only same-origin paths are honoured; anything
 * else (absolute URLs, protocol-relative `//host`, the login page itself) falls back to the portal.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/portal';
  }
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/callback')) {
    return '/portal';
  }
  return value;
}

/** The login URL that brings the visitor back to `path` once they are signed in. */
export function loginPathFor(path: string): string {
  const target = safeReturnTo(path);
  return target === '/portal' ? '/login' : `/login?returnTo=${encodeURIComponent(target)}`;
}
