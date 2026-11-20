import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

function getRelative(date, locale) {
  if (!date) return '';
  const dateObj = new Date(date);
  if (isNaN(dateObj.getTime())) return '';

  const seconds = Math.round((dateObj.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (abs < 60)     return rtf.format(Math.round(seconds), 'second');
  if (abs < 3600)   return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400)  return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 604800) return rtf.format(Math.round(seconds / 86400), 'day');
  // Fall back to absolute date for older events
  return dateObj.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function useRelativeTime(date) {
  const { i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];
  const [label, setLabel] = useState(() => getRelative(date, locale));

  useEffect(() => {
    setLabel(getRelative(date, locale));
    const id = setInterval(() => setLabel(getRelative(date, locale)), 30_000);
    return () => clearInterval(id);
  }, [date, locale]);

  return label;
}
