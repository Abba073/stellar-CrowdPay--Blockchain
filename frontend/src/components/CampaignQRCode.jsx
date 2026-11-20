import React, { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

export default function CampaignQRCode({ url, size = 180 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !url) return;
    QRCode.toCanvas(canvasRef.current, url, {
      width: size,
      margin: 2,
      color: { dark: '#111111', light: '#ffffff' },
    });
  }, [url, size]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
      <canvas ref={canvasRef} role="img" aria-label={`QR code for ${url}`} />
      <a
        href={url}
        download="campaign-qr.png"
        aria-label="Download QR code image"
        onClick={(e) => {
          e.preventDefault();
          const link = document.createElement('a');
          link.download = 'campaign-qr.png';
          link.href = canvasRef.current.toDataURL();
          link.click();
        }}
        style={{ fontSize: '0.8rem', color: '#7c3aed', fontWeight: 600 }}
      >
        Download QR
      </a>
    </div>
  );
}
