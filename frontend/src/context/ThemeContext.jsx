import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { getStorageItem, setStorageItem } from '../lib/storage';

const ThemeContext = createContext();

function getStoredTheme() {
  const saved = getStorageItem('theme');
  return saved === 'dark' || saved === 'light' ? saved : null;
}

function prefersDark() {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    );
  } catch {
    return false;
  }
}

export function ThemeProvider({ children }) {
  const [dark, setDark] = useState(() => {
    const saved = getStoredTheme();
    if (saved) return saved === 'dark';
    return prefersDark();
  });
  const manualPreference = useRef(getStoredTheme() !== null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (manualPreference.current) {
      setStorageItem('theme', dark ? 'dark' : 'light');
    }
  }, [dark]);

  useEffect(() => {
    let mediaQuery;
    try {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return undefined;
      }
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return undefined;
    }

    const handleChange = (event) => {
      if (!manualPreference.current) {
        setDark(event.matches);
      }
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
    if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }
    return undefined;
  }, []);

  const toggleTheme = () => {
    manualPreference.current = true;
    setDark((prev) => !prev);
  };

  return <ThemeContext.Provider value={{ dark, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
