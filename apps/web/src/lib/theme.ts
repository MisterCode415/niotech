import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

/** Must match the pre-paint script in index.html, which applies the theme before React loads. */
const STORAGE_KEY = 'nio.theme';

function readTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Light by default; the visitor's choice is remembered per browser and shared across tabs. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setTheme(readTheme());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Private browsing can refuse storage; the switch still applies to this page.
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
