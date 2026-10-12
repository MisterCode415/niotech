import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Automatic logoff (HIPAA 164.312(a)(2)(iii)). Activity is shared across tabs through a
 * localStorage timestamp, so working in one tab keeps the others alive and an abandoned
 * workstation signs every tab out. A laptop that sleeps past the limit signs out on wake because
 * the check compares wall-clock time rather than counting timer ticks.
 */

const ACTIVITY_KEY = 'nio.lastActivity';
const WARNING_SECONDS = 60;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel'] as const;

const DEFAULT_MINUTES = 15;

/** Idle limit in minutes; override at build time with VITE_IDLE_TIMEOUT_MINUTES. */
export function idleTimeoutMinutes(): number {
  const raw = Number(import.meta.env.VITE_IDLE_TIMEOUT_MINUTES);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_MINUTES;
}

function readLast(): number {
  const value = Number(localStorage.getItem(ACTIVITY_KEY));
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

function writeLast(at: number): void {
  try {
    localStorage.setItem(ACTIVITY_KEY, String(at));
  } catch {
    // Storage may be unavailable (private mode); the in-memory copy still enforces the limit.
  }
}

export interface IdleState {
  /** Seconds until sign-out while the warning is showing; null otherwise. */
  secondsLeft: number | null;
  /** Counts as activity; wired to the warning's "stay signed in" button. */
  keepAlive: () => void;
}

export function useIdleLogout(options: { enabled: boolean; onTimeout: () => void }): IdleState {
  const { enabled, onTimeout } = options;
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const lastActivity = useRef(Date.now());
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const markActive = useCallback(() => {
    const now = Date.now();
    // Throttle storage writes; one a second is plenty against a minutes-long limit.
    if (now - lastActivity.current < 1000) return;
    lastActivity.current = now;
    writeLast(now);
  }, []);

  const keepAlive = useCallback(() => {
    const now = Date.now();
    lastActivity.current = now;
    writeLast(now);
    setSecondsLeft(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSecondsLeft(null);
      return;
    }

    const limitMs = idleTimeoutMinutes() * 60_000;
    // A previous session's stamp must not sign a fresh login out immediately.
    lastActivity.current = Date.now();
    writeLast(lastActivity.current);

    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACTIVITY_KEY && event.newValue) {
        lastActivity.current = Math.max(lastActivity.current, Number(event.newValue));
      }
    };

    function tick() {
      // Another tab may have been busier than this one.
      lastActivity.current = Math.max(lastActivity.current, readLast());
      const idleMs = Date.now() - lastActivity.current;
      if (idleMs >= limitMs) {
        localStorage.removeItem(ACTIVITY_KEY);
        setSecondsLeft(null);
        onTimeoutRef.current();
        return;
      }
      const remaining = Math.ceil((limitMs - idleMs) / 1000);
      setSecondsLeft(remaining <= WARNING_SECONDS ? remaining : null);
    }

    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, markActive, { passive: true });
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('storage', onStorage);
    const timer = window.setInterval(tick, 1000);

    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, markActive);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
      window.clearInterval(timer);
    };
  }, [enabled, markActive]);

  return { secondsLeft, keepAlive };
}
