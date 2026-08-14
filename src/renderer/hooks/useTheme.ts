import { useSyncExternalStore } from 'react';

export type AppTheme = 'light' | 'dark';

const STORAGE_KEY = 'ignis-theme';
const listeners = new Set<() => void>();

const getPreferredTheme = (): AppTheme => {
  const storedTheme = window.localStorage.getItem(STORAGE_KEY);
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const applyTheme = (theme: AppTheme): void => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
};

let currentTheme: AppTheme = getPreferredTheme();
applyTheme(currentTheme);

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = (): AppTheme => currentTheme;

export const setAppTheme = (theme: AppTheme): void => {
  if (theme === currentTheme) {
    return;
  }

  currentTheme = theme;
  window.localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
  listeners.forEach((listener) => listener());
};

export const useTheme = (): { theme: AppTheme; toggleTheme: () => void } => {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return {
    theme,
    toggleTheme: () => setAppTheme(theme === 'light' ? 'dark' : 'light')
  };
};
