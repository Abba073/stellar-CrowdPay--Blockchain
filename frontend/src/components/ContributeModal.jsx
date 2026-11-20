import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getNetwork,
  isConnected as isFreighterConnected,
  requestAccess,
  signTransaction,
} from '@stellar/freighter-api';
import { api } from '../services/api';
import { stellarExpertTxUrl } from '../config/stellar';
import { calculateFee } from '../lib/amounts';

export default function ContributeModal({
  campaign,
  onClose,
  onSuccess,
  guestFreighterMode = false,
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  const [sendAsset, setSendAsset] = useState(campaign.asset_type);
  const [paymentMethod, setPaymentMethod] = useState(
    guestFreighterMode ? 'freighter' : 'custodial'
  );
  const [anchorInfo, setAnchorInfo] = useState({ anchors: [] });
  const [selectedAnchorId, setSelectedAnchorId] = useState('');
  const [anchorSession, setAnchorSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState(() => t('contribute.submitting'));
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState('');
  const [quoteError, setQuoteError] = useState('');
  const [quote, setQuote] = useState(null);
  const [phase, setPhase] = useState('form');
  const [result, setResult] = useState(null);
  const [feeBps, setFeeBps] = useState(0);
  const [feePreview, setFeePreview] = useState(null);
  const [feeError, setFeeError] = useState(null);

  useEffect(() => {
    api
      .getPlatformConfig()
      .then((cfg) => setFeeBps(cfg.platform_fee_bps || 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!feeBps || !destAmount || Number(destAmount) <= 0) {
      setFeePreview(null);
      setFeeError(null);
      return;
    }
    try {
      const { feeAmount: feeAmt, netAmount: netAmt } = calculateFee(destAmount, feeBps);
      setFeePreview({ feeAmount: feeAmt, netAmount: netAmt });
      setFeeError(null);
    } catch (err) {
      setFeePreview(null);
      setFeeError(err.message || t('contribute.enterAmount'));
    }
  }, [destAmount, feeBps, t]);
  const [freighterAvailable, setFreighterAvailable] = useState(false);
  const [freighterChecked, setFreighterChecked] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const anchorPopupRef = useRef(null);

  const modalRef = useRef(null);

  // SEND_OPTIONS built with translated labels so they reflect the active language
  const SEND_OPTIONS = [
    { value: 'XLM', label: t('contribute.xlmLabel'), hint: t('contribute.xlmHint') },
    { value: 'USDC', label: t('contribute.usdcLabel'), hint: t('contribute.usdcHint') },
  ];

  const selectedAnchor =
    anchorInfo.anchors.find((anchor) => anchor.id === selectedAnchorId) || null;
  const effectiveSendAsset =
    paymentMethod === 'anchor' ? selectedAnchor?.asset?.code || campaign.asset_type : sendAsset;
  const isPathPayment = effectiveSendAsset !== campaign.asset_type;
  const destAmount = amount.trim();

  // Authoritative cumulative contribution total for the current user, returned
  // by the backend on the campaign payload. The per-user limit is enforced
  // against this total — never by summing a paginated contributions list (#176).
  const contributedSoFar = Number(campaign.user_contributed_amount) || 0;
  const perUserRemaining = campaign.max_per_user
    ? Math.max(0, Number(campaign.max_per_user) - contributedSoFar)
    : 0;

  // Fetch anchor info on mount (the per-user cap total comes from the campaign payload)
  useEffect(() => {
    api.getAnchorInfo().then(setAnchorInfo).catch(() => {});
  }, [campaign.id]);

  // Check Freighter availability
  useEffect(() => {
    isFreighterConnected()
      .then((res) => {
        const connected = res?.isConnected ?? res;
        setFreighterAvailable(!!connected);
        setFreighterChecked(true);
      })
      .catch(() => setFreighterChecked(true));
  }, []);

  const fetchQuote = useCallback(async () => {
    if (!isPathPayment || !effectiveSendAsset || !destAmount || Number(destAmount) <= 0) {
      setQuote(null);
      setQuoteError('');
      return;
    }
    setQuoteLoading(true);
    setQuoteError('');
    try {
      const q = await api.quoteContribution({
        send_asset: effectiveSendAsset,
        dest_asset: campaign.asset_type,
        dest_amount: destAmount,
      });
      setQuote(q);
    } catch (err) {
      setQuote(null);
      setQuoteError(friendlyQuoteError(err, t));
    } finally {
      setQuoteLoading(false);
    }
  }, [isPathPayment, destAmount, effectiveSendAsset, campaign.asset_type, t]);

  useEffect(() => {
    if (!isPathPayment) {
      setQuote(null);
      setQuoteError('');
      return;
    }
    const timer = setTimeout(() => {
      fetchQuote();
    }, 450);
    return () => clearTimeout(timer);
  }, [fetchQuote, isPathPayment]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const connection = await isFreighterConnected();
        if (active) {
          setFreighterAvailable(Boolean(connection?.isConnected));
        }
      } catch {
        if (active) {
          setFreighterAvailable(false);
        }
      } finally {
        if (active) {
          setFreighterChecked(true);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    api
      .getAnchorInfo()
      .then((info) => {
        if (!active) return;
        setAnchorInfo(info || { anchors: [] });
        const firstAvailable = (info?.anchors || []).find((anchor) => anchor.available);
        if (firstAvailable) {
          setSelectedAnchorId(firstAvailable.id);
        }
      })
      .catch(() => {
        if (active) {
          setAnchorInfo({ anchors: [] });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'anchor' || !anchorSession?.id) return undefined;
    let stopped = false;

    const closePopup = () => {
      if (anchorPopupRef.current && !anchorPopupRef.current.closed) {
        anchorPopupRef.current.close();
      }
    };

    const poll = async () => {
      try {
        const next = await api.getAnchorDepositStatus(anchorSession.id);
        if (stopped) return;
        setAnchorSession(next);
        if (next.contribution_tx_hash) {
          setResult({
            tx_hash: next.contribution_tx_hash,
            conversion_quote: next.conversion_quote,
            anchor_transaction_id: next.anchor_transaction_id,
            anchor_id: next.anchor_id,
          });
          setPhase('success');
          closePopup();
          onSuccess();
          return;
        }
        if (next.status === 'failed') {
          setError(next.last_error || t('contribute.anchorDepositFailed'));
          setPhase('form');
          closePopup();
        }
      } catch (err) {
        if (!stopped) {
          setError(err.message || t('contribute.anchorStatusError'));
        }
      }
    };

    poll();
    const intervalId = window.setInterval(poll, 4000);
    return () => {
      stopped = true;
      window.clearInterval(intervalId);
    };
  }, [anchorSession?.id, onSuccess, phase, t]);

  useEffect(() => {
    const prevActive = document.activeElement;
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();

    function trapTab(e) {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    modal.addEventListener('keydown', trapTab);
    return () => {
      modal.removeEventListener('keydown', trapTab);
      prevActive?.focus?.();
    };
  }, [phase]);

  async function submitWithCustodial() {
    setLoadingLabel(t('contribute.submittingWithWallet'));
    return api.contribute({
      campaign_id: campaign.id,
      amount: destAmount,
      send_asset: sendAsset,
      display_name: displayName.trim() || undefined,
    });
  }

  async function submitWithFreighter() {
    setLoadingLabel(t('contribute.connectingFreighter'));
    const access = await requestAccess();
    if (access?.error) {
      throw new Error(friendlyFreighterError(access.error, t('contribute.freighterConnectError')));
    }
    const signerAddress = access?.address;
    if (!signerAddress) {
      throw new Error(t('contribute.freighterNoAccount'));
    }

    setLoadingLabel(t('contribute.preparingTx'));
    const prepared = await api.prepareContribution({
      campaign_id: campaign.id,
      amount: destAmount,
      send_asset: sendAsset,
      sender_public_key: signerAddress,
      display_name: displayName.trim() || undefined,
    });

    setLoadingLabel(t('contribute.checkingFreighterNetwork'));
    const network = await getNetwork();
    if (network?.error) {
      throw new Error(
        friendlyFreighterError(network.error, t('contribute.freighterNetworkReadError'))
      );
    }
    if (network?.networkPassphrase !== prepared.network_passphrase) {
      const current = network?.network || t('contribute.anotherNetwork', 'another network');
      throw new Error(
        t('contribute.freighterNetworkMismatch', { current, expected: prepared.network_name })
      );
    }

    setLoadingLabel(t('contribute.waitingForSignature'));
    const signed = await signTransaction(prepared.unsigned_xdr, {
      networkPassphrase: prepared.network_passphrase,
      address: signerAddress,
    });
    if (signed?.error) {
      throw new Error(friendlyFreighterError(signed.error, t('contribute.freighterSignError')));
    }
    if (!signed?.signedTxXdr) {
      throw new Error(t('contribute.freighterNoSigned'));
    }

    setLoadingLabel(t('contribute.submittingSigned'));
    return api.submitSignedContribution({
      prepare_token: prepared.prepare_token,
      signed_xdr: signed.signedTxXdr,
    });
  }

  async function submitWithAnchor() {
    if (!selectedAnchorId) {
      throw new Error(t('contribute.noAnchorAvailable'));
    }

    const popup = window.open('', 'crowdpay-anchor-deposit', 'popup,width=520,height=780');
    anchorPopupRef.current = popup;

    setLoadingLabel(t('contribute.preparingDeposit'));
    const session = await api.startAnchorDeposit({
      campaign_id: campaign.id,
      amount: destAmount,
      anchor_id: selectedAnchorId,
    });

    if (popup && !popup.closed) {
      popup.location.href = session.interactive_url;
    } else {
      window.open(session.interactive_url, '_blank', 'noopener,noreferrer');
    }

    setAnchorSession(session);
    setPhase('anchor');
    return session;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!destAmount || Number(destAmount) <= 0) {
      setError(t('contribute.enterAmount'));
      return;
    }

    const amountNum = Number(destAmount);
    if (campaign.min_contribution && amountNum < Number(campaign.min_contribution)) {
      setError(
        t('contribute.belowMinimum', {
          amount: campaign.min_contribution,
          asset: campaign.asset_type,
        })
      );
      return;
    }
    if (campaign.max_contribution && amountNum > Number(campaign.max_contribution)) {
      setError(
        t('contribute.aboveMaximum', {
          amount: campaign.max_contribution,
          asset: campaign.asset_type,
        })
      );
      return;
    }
    if (campaign.max_per_user) {
      const existingSum = contributedSoFar;
      const maxPerUser = Number(campaign.max_per_user);
      if (existingSum + amountNum > maxPerUser) {
        setError(t('contribute.aboveMaximumPerUser', {
          existing: existingSum,
          limit: maxPerUser,
          asset: campaign.asset_type,
        }));
        return;
      }
    }

    setLoading(true);
    setLoadingLabel(t('contribute.submitting'));
    setError('');
    try {
      const data =
        paymentMethod === 'anchor'
          ? await submitWithAnchor()
          : paymentMethod === 'freighter'
            ? await submitWithFreighter()
            : await submitWithCustodial();
      if (paymentMethod === 'anchor') return;

      setResult(data);
      setPhase('confirming');
      setLoadingLabel(t('contribute.confirmingProgress'));

      // Poll finalization endpoint until status is 'finalized' or 'failed'
      const pollFinalization = async (txHash, maxAttempts = 15) => {
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const finalizationResult = await api.getContributionFinalization(txHash);
            if (finalizationResult.finalization_status === 'finalized') {
              setPhase('success');
              onSuccess();
              return;
            }
            if (finalizationResult.finalization_status === 'failed') {
              setPhase('failed');
              setError(t('contribute.finalizationFailed'));
              return;
            }
          } catch {
            // Keep polling on error
          }
        }
        setPhase('pending');
      };

      pollFinalization(data.tx_hash);
    } catch (err) {
      if (paymentMethod === 'anchor' && anchorPopupRef.current && !anchorPopupRef.current.closed) {
        anchorPopupRef.current.close();
      }
      setError(
        paymentMethod === 'freighter'
          ? friendlyFreighterError(err, t('contribute.freighterError'))
          : friendlyContributeError(err, t)
      );
    } finally {
      setLoading(false);
      setLoadingLabel(t('contribute.submitting'));
    }
  }

  function handleClose() {
    if (anchorPopupRef.current && !anchorPopupRef.current.closed) {
      anchorPopupRef.current.close();
    }
    if (phase === 'success') {
      onSuccess?.();
    }
    onClose();
  }

  return (
    <div className="modal-overlay" style={styles.overlay} onClick={handleClose} role="presentation">
      <div
        className="modal-shell"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contribute-title"
        onClick={(e) => e.stopPropagation()}
      >
        {phase === 'form' ? (
          <>
            <h2 id="contribute-title" style={styles.title}>
              {t('contribute.title')}
            </h2>
            <p style={styles.subtitle}>
              {t('contribute.subtitle', { asset: campaign.asset_type })}
            </p>

            <form noValidate onSubmit={handleSubmit}>
              <fieldset style={{ border: 'none', margin: '0 0 1rem', padding: 0 }}>
                <legend className="label-strong" style={{ marginBottom: '0.45rem' }}>
                  {t('contribute.paymentMethod')}
                </legend>
                <div
                  className="asset-picker"
                  role="radiogroup"
                  aria-label={t('contribute.paymentMethodAria')}
                >
                  {!guestFreighterMode && (
                    <label
                      className={`asset-picker__option${paymentMethod === 'custodial' ? ' asset-picker__option--selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="payment_method"
                        value="custodial"
                        checked={paymentMethod === 'custodial'}
                        onChange={() => setPaymentMethod('custodial')}
                      />
                      <div className="asset-picker__code">{t('contribute.custodialWallet')}</div>
                      <div className="asset-picker__hint">
                        {t('contribute.custodialWalletHint')}
                      </div>
                    </label>
                  )}
                  {(freighterAvailable || guestFreighterMode) && (
                    <label
                      className={`asset-picker__option${paymentMethod === 'freighter' ? ' asset-picker__option--selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="payment_method"
                        value="freighter"
                        checked={paymentMethod === 'freighter'}
                        onChange={() => setPaymentMethod('freighter')}
                      />
                      <div className="asset-picker__code">{t('contribute.freighter')}</div>
                      <div className="asset-picker__hint">{t('contribute.freighterHint')}</div>
                    </label>
                  )}
                  {anchorInfo.anchors.some((anchor) => anchor.available) && (
                    <label
                      className={`asset-picker__option${paymentMethod === 'anchor' ? ' asset-picker__option--selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="payment_method"
                        value="anchor"
                        checked={paymentMethod === 'anchor'}
                        onChange={() => setPaymentMethod('anchor')}
                      />
                      <div className="asset-picker__code">{t('contribute.anchorDeposit')}</div>
                      <div className="asset-picker__hint">{t('contribute.anchorDepositHint')}</div>
                    </label>
                  )}
                </div>
                {freighterChecked &&
                  !freighterAvailable &&
                  (paymentMethod === 'freighter' || guestFreighterMode) && (
                    <span id="contrib-wallet-help" style={styles.help}>
                      {t('contribute.freighterNotDetectedLink')}{' '}
                      <a
                        href="https://www.freighter.app/"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('contribute.installFreighter')}
                      </a>
                    </span>
                  )}
              </fieldset>

              {paymentMethod === 'anchor' ? (
                <>
                  <fieldset style={{ border: 'none', margin: '0 0 1rem', padding: 0 }}>
                    <legend className="label-strong" style={{ marginBottom: '0.45rem' }}>
                      {t('contribute.depositPartner')}
                    </legend>
                    <div
                      className="asset-picker"
                      role="radiogroup"
                      aria-label={t('contribute.depositPartnerAria')}
                    >
                      {anchorInfo.anchors
                        .filter((anchor) => anchor.available)
                        .map((anchor) => (
                          <label
                            key={anchor.id}
                            className={`asset-picker__option${selectedAnchorId === anchor.id ? ' asset-picker__option--selected' : ''}`}
                          >
                            <input
                              type="radio"
                              name="anchor_id"
                              value={anchor.id}
                              checked={selectedAnchorId === anchor.id}
                              onChange={() => setSelectedAnchorId(anchor.id)}
                            />
                            <div className="asset-picker__code">{anchor.name}</div>
                            <div className="asset-picker__hint">
                              {t('contribute.depositAsset', {
                                asset: anchor.asset.code,
                                environment: anchor.environment,
                              })}
                            </div>
                          </label>
                        ))}
                    </div>
                  </fieldset>
                  {selectedAnchor && (
                    <div
                      className="alert alert--info"
                      style={{ marginBottom: '1rem' }}
                      role="status"
                    >
                      {t('contribute.anchorFlowSummary', {
                        name: selectedAnchor.name,
                        asset: selectedAnchor.asset.code,
                      })}
                    </div>
                  )}
                </>
              ) : (
                <fieldset style={{ border: 'none', margin: '0 0 1rem', padding: 0 }}>
                  <legend className="label-strong" style={{ marginBottom: '0.45rem' }}>
                    {t('contribute.payWith')}
                  </legend>
                  <div
                    className="asset-picker"
                    role="radiogroup"
                    aria-label={t('contribute.assetToSendAria')}
                  >
                    {SEND_OPTIONS.map((opt) => (
                      <label
                        key={opt.value}
                        className={`asset-picker__option${sendAsset === opt.value ? ' asset-picker__option--selected' : ''}`}
                      >
                        <input
                          type="radio"
                          name="send_asset"
                          value={opt.value}
                          checked={sendAsset === opt.value}
                          onChange={() => setSendAsset(opt.value)}
                        />
                        <div className="asset-picker__code">{opt.label}</div>
                        <div className="asset-picker__hint">{opt.hint}</div>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              <div className="form-stack" style={{ marginBottom: '0.25rem' }}>
                <label className="label-strong" htmlFor="contrib-amount">
                  {t('contribute.amount', { asset: campaign.asset_type })}
                </label>
                <input
                  id="contrib-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.0000001"
                  step="any"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-describedby="contrib-amount-help"
                />
                <span id="contrib-amount-help" style={styles.help}>
                  <span style={{ display: 'block', marginBottom: '0.25rem' }}>
                    {t('contribute.amountCreditedHelp', { asset: campaign.asset_type })}
                  </span>
                  {(campaign.min_contribution ||
                    campaign.max_contribution ||
                    campaign.max_per_user) && (
                    <span
                      style={{
                        display: 'block',
                        marginTop: '0.35rem',
                        borderTop: '1px dashed var(--color-border-lighter)',
                        paddingTop: '0.35rem',
                      }}
                    >
                      <strong>{t('contribute.limitsTitle')}</strong>
                      <ul
                        style={{
                          margin: '0.25rem 0 0',
                          paddingLeft: '1rem',
                          listStyleType: 'disc',
                        }}
                      >
                        {campaign.min_contribution && (
                          <li>
                            {t('contribute.limitMin', {
                              amount: Number(campaign.min_contribution).toLocaleString(),
                              asset: campaign.asset_type,
                            })}
                          </li>
                        )}
                        {campaign.max_contribution && (
                          <li>
                            {t('contribute.limitMax', {
                              amount: Number(campaign.max_contribution).toLocaleString(),
                              asset: campaign.asset_type,
                            })}
                          </li>
                        )}
                        {campaign.max_per_user && (
                          <li>
                            {contributedSoFar > 0
                              ? t('contribute.limitPerUserRemaining', {
                                  amount: Number(campaign.max_per_user).toLocaleString(),
                                  asset: campaign.asset_type,
                                  existing: contributedSoFar.toLocaleString(),
                                  remaining: perUserRemaining.toLocaleString(),
                                })
                              : t('contribute.limitPerUser', {
                                  amount: Number(campaign.max_per_user).toLocaleString(),
                                  asset: campaign.asset_type,
                                })}
                          </li>
                        )}
                      </ul>
                    </span>
                  )}
                </span>
              </div>

              <div className="form-stack" style={{ marginBottom: '1rem' }}>
                <label className="label-strong" htmlFor="contrib-display-name">
                  {t('contribute.displayName')}{' '}
                  <span style={{ fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                    {t('contribute.optional')}
                  </span>
                </label>
                <input
                  id="contrib-display-name"
                  placeholder={t('contribute.displayNamePlaceholder')}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={50}
                />
                <span style={styles.help}>{t('contribute.displayNameHelp')}</span>
              </div>

              {isPathPayment && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem' }} role="status">
                  <strong>{t('contribute.crossAsset')}</strong>{' '}
                  {t('contribute.crossAssetBody', {
                    from: effectiveSendAsset,
                    to: campaign.asset_type,
                  })}
                </div>
              )}

              {paymentMethod === 'freighter' && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem' }} role="status">
                  <strong>{t('contribute.nonCustodial')}</strong> {t('contribute.nonCustodialBody')}
                </div>
              )}

              {paymentMethod === 'anchor' && selectedAnchor && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem' }} role="status">
                  <strong>{t('contribute.anchorDepositInfo')}</strong>{' '}
                  {t('contribute.anchorDepositBody', { name: selectedAnchor.name })}
                </div>
              )}

              {isPathPayment && destAmount && Number(destAmount) > 0 && (
                <div style={{ marginTop: '0.85rem', minHeight: '3.5rem' }}>
                  {quoteLoading && (
                    <p style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
                      {t('contribute.fetchingQuote')}
                    </p>
                  )}
                  {!quoteLoading && quote && (
                    <div className="alert alert--success" role="status">
                      <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>
                        {t('contribute.estimatedFromWallet')}
                      </div>
                      <div style={{ fontSize: '0.875rem', lineHeight: 1.45 }}>
                        Up to <strong>{quote.max_send_amount}</strong> {effectiveSendAsset}{' '}
                        (includes a small slippage buffer).
                        {Array.isArray(quote.path) && quote.path.length > 0 && (
                          <>
                            {' '}
                            {t('contribute.quotePath', {
                              from: effectiveSendAsset,
                              path: quote.path.join(' → '),
                              to: campaign.asset_type,
                            })}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                  {!quoteLoading && quoteError && (
                    <p className="alert alert--error" role="alert">
                      {quoteError}
                    </p>
                  )}
                </div>
              )}

              {feeBps > 0 && destAmount && Number(destAmount) > 0 && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem', fontSize: '0.875rem' }} role="status">
                  {feeError ? (
                    <p style={{ color: 'var(--color-danger-text, #dc2626)' }}>{feeError}</p>
                  ) : feePreview ? (
                    <>
                      <strong>{t('contribute.platformFee')}</strong>{' '}
                      {t('contribute.feeDetail', {
                        pct: feeBps / 100,
                        fee: feePreview.feeAmount,
                        asset: campaign.asset_type,
                        net: feePreview.netAmount,
                      })}
                    </>
                  ) : null}
                </div>
              )}

              {error && (
                <p className="alert alert--error" style={{ marginTop: '0.85rem' }} role="alert">
                  {error}
                </p>
              )}

              <div style={styles.actions}>
                <button type="button" className="btn-secondary" onClick={handleClose}>
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={loading || (isPathPayment && (quoteLoading || !!quoteError || !quote))}
                >
                  {loading
                    ? loadingLabel
                    : paymentMethod === 'anchor'
                      ? t('contribute.openDepositFlow')
                      : paymentMethod === 'freighter'
                        ? t('contribute.reviewInFreighter')
                        : t('contribute.confirmPayment')}
                </button>
              </div>
            </form>
          </>
        ) : phase === 'anchor' ? (
          <div>
            <h2 id="contribute-title" style={styles.title}>
              {t('contribute.completeDeposit')}
            </h2>
            <p className="alert alert--info" style={{ marginBottom: '1rem' }} role="status">
              {t('contribute.completeDepositBody')}
            </p>
            {anchorSession?.anchor_transaction_id && (
              <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                <strong>{t('contribute.anchorTransaction')}</strong>{' '}
                {anchorSession.anchor_transaction_id}
              </p>
            )}
            {anchorSession?.conversion_quote && (
              <div
                className="alert alert--success"
                style={{ marginBottom: '1rem', fontSize: '0.85rem' }}
              >
                <strong>{t('contribute.plannedContribution')}</strong>{' '}
                {t('contribute.plannedContributionDetail', {
                  maxSend: anchorSession.conversion_quote.max_send_amount,
                  sendAsset: anchorSession.conversion_quote.send_asset,
                  campaignAmount: anchorSession.conversion_quote.campaign_amount,
                  campaignAsset: anchorSession.conversion_quote.campaign_asset,
                })}
              </div>
            )}
            {anchorSession?.interactive_url && (
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%', marginBottom: '0.75rem' }}
                onClick={() =>
                  window.open(anchorSession.interactive_url, '_blank', 'noopener,noreferrer')
                }
              >
                {t('contribute.reopenDepositWindow')}
              </button>
            )}
            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%' }}
              onClick={handleClose}
            >
              {t('common.close')}
            </button>
          </div>
        ) : phase === 'failed' || phase === 'pending' ? (
          <div>
            <h2 id="contribute-title" style={styles.title}>
              {phase === 'failed' ? t('contribute.paymentFailed') : t('contribute.paymentPending')}
            </h2>
            <p
              className={`alert ${phase === 'failed' ? 'alert--error' : 'alert--info'}`}
              style={{ marginBottom: '1rem' }}
              role={phase === 'failed' ? 'alert' : 'status'}
            >
              {phase === 'failed'
                ? error
                : t('contribute.paymentPendingBody')}
            </p>
            {result?.tx_hash && (
              <p style={{ fontSize: '0.875rem', marginBottom: '1rem', wordBreak: 'break-all', textAlign: 'center' }}>
                <a
                  href={stellarExpertTxUrl(result.tx_hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                >
                  {t('contribute.viewTransactionOnStellarExpert')}
                </a>
              </p>
            )}
            <button type="button" className="btn-primary" style={{ width: '100%' }} onClick={handleClose}>
              {t('common.close')}
            </button>
          </div>
        ) : phase === 'confirming' ? (
          <div>
            <h2 id="contribute-title" style={styles.title}>
              {t('contribute.confirming')}
            </h2>
            <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  border: '4px solid var(--color-border-lighter)',
                  borderTop: '4px solid var(--color-accent)',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                  margin: '0 auto',
                  marginBottom: '1rem',
                }}
              />
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.95rem' }}>
                {t('contribute.confirmingBody')}
              </p>
            </div>
            {result?.tx_hash && (
              <p
                style={{
                  fontSize: '0.875rem',
                  marginBottom: '1rem',
                  wordBreak: 'break-all',
                  textAlign: 'center',
                }}
              >
                <a
                  href={stellarExpertTxUrl(result.tx_hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                >
                  {t('contribute.viewTransactionOnStellarExpert')}
                </a>
              </p>
            )}
            <style>{`
              @keyframes spin {
                to { transform: rotate(360deg); }
              }
            `}</style>
          </div>
        ) : (
          <div>
            <h2 id="contribute-title" style={styles.title}>
              {t('contribute.paymentSubmitted')}
            </h2>
            <p className="alert alert--success" style={{ marginBottom: '1rem' }} role="status">
              {t('contribute.paymentSubmittedBody')}
            </p>
            {result?.tx_hash && (
              <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem', wordBreak: 'break-all' }}>
                <strong>{t('contribute.transaction')}</strong>{' '}
                <a
                  href={stellarExpertTxUrl(result.tx_hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                >
                  {t('contribute.viewOnStellarExpert')}
                </a>
              </p>
            )}
            {result?.conversion_quote && (
              <div
                className="alert alert--info"
                style={{ marginBottom: '1rem', fontSize: '0.85rem' }}
              >
                <strong>{t('contribute.conversionSummary')}</strong>{' '}
                {t('contribute.conversionSummaryDetail', {
                  maxSend: result.conversion_quote.max_send_amount,
                  sendAsset: result.conversion_quote.send_asset,
                  campaignAmount: result.conversion_quote.campaign_amount,
                  campaignAsset: result.conversion_quote.campaign_asset,
                })}
              </div>
            )}
            {result?.anchor_transaction_id && (
              <div
                className="alert alert--info"
                style={{ marginBottom: '1rem', fontSize: '0.85rem' }}
              >
                <strong>{t('contribute.anchorReference')}</strong> {result.anchor_transaction_id}
              </div>
            )}

            {error && (
              <p className="alert alert--error" style={{ marginBottom: '1rem' }} role="alert">
                {error}
              </p>
            )}

            <div
              style={{
                marginTop: '1.5rem',
                borderTop: '1px solid var(--color-border-lighter)',
                paddingTop: '1.25rem',
              }}
            >
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                {t('contribute.tellFriends')}
              </h3>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ flex: 1, fontSize: '0.85rem' }}
                  onClick={() => {
                    const text = encodeURIComponent(
                      t('contribute.shareText', {
                        title: campaign.title,
                        url: `${window.location.origin}/campaigns/${campaign.id}`,
                      })
                    );
                    window.open(`https://twitter.com/intent/tweet?text=${text}`, '_blank', 'noopener,noreferrer');
                  }}
                >
                  {t('contribute.shareOnX')}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ flex: 1, fontSize: '0.85rem' }}
                  onClick={() => {
                    const text = encodeURIComponent(
                      t('contribute.shareText', {
                        title: campaign.title,
                        url: `${window.location.origin}/campaigns/${campaign.id}`,
                      })
                    );
                    window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener,noreferrer');
                  }}
                >
                  {t('contribute.whatsapp')}
                </button>
              </div>
            </div>

            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%', marginTop: '1.25rem' }}
              onClick={handleClose}
            >
              {t('common.done')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error helpers — accept `t` so messages can be translated
// ---------------------------------------------------------------------------

function friendlyQuoteError(err, t) {
  if (err.status === 404) {
    return t('contribute.quoteUnavailable');
  }
  return err.message || t('contribute.quoteLoadError');
}

function friendlyContributeError(err, t) {
  if (err.status === 422) {
    return err.message || t('contribute.conversionFailed');
  }
  if (err.status === 404) {
    return t('contribute.campaignNotFound');
  }
  if (err.status === 400) {
    return err.message || t('contribute.amountAssetError');
  }
  return err.message || t('contribute.contributeError');
}

function friendlyFreighterError(err, fallback) {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string') return err.message;
  if (typeof err.error === 'string') return err.error;
  if (err.error && typeof err.error.message === 'string') return err.error.message;
  return fallback;
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: '0.75rem',
  },
  title: {
    fontSize: '1.2rem',
    fontWeight: 800,
    marginBottom: '0.5rem',
    color: 'var(--color-text-primary)',
  },
  subtitle: {
    color: 'var(--color-text-secondary)',
    fontSize: '0.875rem',
    lineHeight: 1.55,
    marginBottom: '1.1rem',
  },
  help: { fontSize: '0.78rem', color: 'var(--color-text-hint)', marginTop: '0.2rem' },
  actions: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: '0.65rem',
    justifyContent: 'stretch',
    marginTop: '1.1rem',
  },
};
