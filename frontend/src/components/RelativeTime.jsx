import React from 'react';
import { useRelativeTime } from '../hooks/useRelativeTime';

export default function RelativeTime({ date, title }) {
  const label = useRelativeTime(date);
  if (!date) return null;
  const dateObj = new Date(date);
  if (isNaN(dateObj.getTime())) return null;

  return (
    <time dateTime={dateObj.toISOString()} title={title ?? dateObj.toLocaleString()}>
      {label}
    </time>
  );
}
