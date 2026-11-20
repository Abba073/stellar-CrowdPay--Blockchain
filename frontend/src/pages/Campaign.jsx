import React, { useEffect, useState, useRef } from 'react';
import { Link, useParams, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import ContributeModal from '../components/ContributeModal';
import RelativeTime from '../components/RelativeTime';
import DisputeModal from '../components/DisputeModal';
import TransactionHistory from '../components/TransactionHistory';
import MilestoneTracker from '../components/MilestoneTracker';
import WithdrawalsSection from '../components/WithdrawalsSection';
import CampaignDetailSkeleton from '../components/skeletons/CampaignDetailSkeleton';
import ContributionListSkeleton from '../components/skeletons/ContributionListSkeleton';
import VerificationBadge from '../components/VerificationBadge';
import CampaignStatusBadge from '../components/CampaignStatusBadge';
import { stellarExpertTxUrl } from '../config/stellar';
import CampaignQRCode from '../components/CampaignQRCode';
import { getNetwork, signTransaction } from '@stellar/freighter-api';
import { isConnected, getPublicKey } from "@stellar/freighter-api";
import { markdownToHtml } from "../lib/markdown";

function progressColor(pct, status) {
  if (status === 'funded' || pct >= 100) return '#10b981'; // green — goal reached
  if (status === 'closed' || status === 'withdrawn' || status === 'refunded' || status === 'failed') return '#6b7280'; // grey — ended
  if (pct >= 75) return '#3b82f6'; // blue — nearly there
  return '#7c3aed'; // default purple
}

function ContributionRow({ c }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(c.sender_public_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={styles.row}>
      <div
        style={{
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
        }}
      >
        <div style={styles.avatar}>
          {(c.display_name || "A")[0].toUpperCase()}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={styles.sender}>{c.display_name || "Anonymous"}</div>
          <div style={styles.convHint}>
            <button
              type="button"
              onClick={handleCopy}
              title="Copy full public key"
              style={{
                background: "none",
                border: "none",
                color: "inherit",
                fontFamily: "monospace",
                fontSize: "inherit",
                cursor: "pointer",
                padding: 0,
              }}
            >
              {c.sender_public_key.slice(0, 4)}…{c.sender_public_key.slice(-4)}
            </button>
            {" • "}
            <RelativeTime date={c.created_at} />
          </div>
          {c.refund_status && (
            <div style={styles.refundTag}>
              {c.refund_status === "pending" && "Refund pending"}
              {c.refund_status === "submitted" && "Refunded"}
              {c.refund_status === "indexed" && "Refunded"}
              {c.refund_status === "failed" && "Refund failed"}
              {c.refund_status === "denied" && "Refund denied"}
            </div>
          )}
          {c.tx_hash && (
            <a
              href={stellarExpertTxUrl(c.tx_hash)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: "0.75rem", color: "#7c3aed", fontWeight: 600 }}
            >
              View on chain ↗
            </a>
          )}
        </div>
      </div>
      {c.amount != null && (
        <span style={styles.amount}>
          {Number(c.amount).toLocaleString()} {c.asset}
        </span>
      )}
    </div>
  );
}

export default function Campaign() {
  const contributeBtnRef = useRef(null);
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, token } = useAuth();

  const [campaign, setCampaign] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [contributions, setContributions] = useState(null);
  const contributionsRef = useRef([]);
  const [totalContributions, setTotalContributions] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [disputeSubmitted, setDisputeSubmitted] = useState(false);
  const [contributed, setContributed] = useState(false);

  const [freighterGuestMode, setFreighterGuestMode] = useState(false);
  const [showCreatedBanner, setShowCreatedBanner] = useState(
    !!location.state?.created,
  );
  const [coverUploadError, setCoverUploadError] = useState(
    location.state?.coverUploadError || "",
  );
  const [updates, setUpdates] = useState([]);
  const [milestones, setMilestones] = useState([]);
  const [updateForm, setUpdateForm] = useState({ title: "", body: "" });
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updatesError, setUpdatesError] = useState("");
  const [isLive, setIsLive] = useState(false);
  const [members, setMembers] = useState([]);
  const [isOwner, setIsOwner] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", role: "viewer" });
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [isEditingCampaign, setIsEditingCampaign] = useState(false);
  const [editFormData, setEditFormData] = useState({
    title: "",
    description: "",
    deadline: "",
  });
  const [editError, setEditError] = useState("");
  const [editSuccess, setEditSuccess] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("contributions");
  const [editingUpdateId, setEditingUpdateId] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundError, setRefundError] = useState("");
  const [refundSuccess, setRefundSuccess] = useState("");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [hasPendingWithdrawal, setHasPendingWithdrawal] = useState(false);

  useEffect(() => {
    document.body.dataset.printUrl = window.location.href;
    document.body.dataset.printDate = new Date().toLocaleDateString();
    return () => {
      delete document.body.dataset.printUrl;
      delete document.body.dataset.printDate;
    };
  }, []);

  useEffect(() => {
    setLoadError("");
    api
      .getCampaign(id, token)
      .then((data) => {
        setCampaign(data);
        if (data.user_role === "owner") {
          setIsOwner(true);
          api
            .getCampaignMembers(id, token)
            .then(setMembers)
            .catch(() => {});
        } else {
          setIsOwner(false);
        }
      })
      .catch((err) => setLoadError(err.message || "Could not load campaign."));
    api
      .getContributions(id, { limit: showAll ? 100 : 10, offset: 0 })
      .then((data) => {
        const nextContributions = data.contributions || [];
        contributionsRef.current = nextContributions;
        setContributions(nextContributions);
        setTotalContributions(data.total || 0);
      })
      .catch(() => {
        contributionsRef.current = [];
        setContributions([]);
        setTotalContributions(0);
      });
    api
      .getMilestones(id)
      .then(setMilestones)
      .catch(() => setMilestones([]));
    api
      .getCampaignUpdates(id, { limit: 20 })
      .then(setUpdates)
      .catch(() => setUpdates([]));
    api
      .getCampaignAnalytics(id)
      .then(setAnalytics)
      .catch(() => setAnalytics(null));

    // Check for pending withdrawals
    if (token) {
      api
        .listWithdrawals(id)
        .then((withdrawals) => {
          const hasPending = withdrawals.some((w) => w.status === "pending");
          setHasPendingWithdrawal(hasPending);
        })
        .catch(() => setHasPendingWithdrawal(false));
    }
  }, [id, token, contributed, showAll]);

  useEffect(() => {
    if (!id) return;
    if (isLive) return;
    if (!campaign) return;

    const isCampaignClosed = [
      "funded",
      "closed",
      "withdrawn",
      "failed",
      "completed",
      "refunded",
    ].includes(campaign.status);
    if (isCampaignClosed) return;

    let intervalId = null;
    let aborted = false;

    const refresh = async () => {
      if (aborted) return;
      if (document.visibilityState !== "visible") return;
      try {
        const [nextCampaign, nextContributionsData] = await Promise.all([
          api.getCampaign(id, token),
          api.getContributions(id, { limit: showAll ? 100 : 10, offset: 0 }),
        ]);
        if (aborted) return;
        setCampaign(nextCampaign);
        const nextContributions = nextContributionsData.contributions || [];
        contributionsRef.current = nextContributions;
        setContributions(nextContributions);
        setTotalContributions(nextContributionsData.total || 0);
      } catch {
        // ignore transient polling errors
      }
    };

    const start = () => {
      if (intervalId != null) return;
      refresh();
      intervalId = window.setInterval(refresh, 15_000);
    };

    const stop = () => {
      if (intervalId == null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();

    return () => {
      aborted = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [id, token, isLive, campaign?.status, showAll]);

  useEffect(() => {
    if (!window.EventSource) return;

    const es = new EventSource(`/api/campaigns/${id}/stream`);

    es.onopen = () => setIsLive(true);

    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      if (msg.type === "contribution") {
        setCampaign((prev) =>
          prev ? { ...prev, raised_amount: msg.raised_amount } : prev,
        );
        const current = contributionsRef.current;
        if (current.some((c) => c.tx_hash === msg.contribution.tx_hash)) return;

        const updated = [msg.contribution, ...current];
        contributionsRef.current = !showAll && updated.length > 10
          ? updated.slice(0, 10)
          : updated;
        setContributions(contributionsRef.current);
        setTotalContributions((total) => total + 1);
      }
    };

    es.onerror = () => {
      setIsLive(false);
      es.close();
    };

    return () => {
      es.close();
      setIsLive(false);
    };
  }, [id, showAll]);

  useEffect(() => {
    if (location.state?.created) {
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  async function handleClone() {
    try {
      const data = await api.getCloneData(id, token);
      navigate('/campaigns/new', { state: { prefill: data } });
    } catch (err) {
      alert(err.message || 'Failed to fetch campaign clone data');
    }
  }

  async function handleInviteSubmit(e) {
    e.preventDefault();
    if (!inviteForm.email) {
      setInviteError("Email is required");
      return;
    }
    setInviteBusy(true);
    setInviteError("");
    setInviteSuccess(false);
    try {
      const newMember = await api.inviteCampaignMember(id, inviteForm, token);
      setMembers((prev) => [...prev, newMember]);
      setInviteForm({ email: "", role: "viewer" });
      setInviteSuccess(true);
    } catch (err) {
      setInviteError(err.message || "Failed to invite member");
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRoleChange(userId, newRole) {
    try {
      const updated = await api.updateCampaignMemberRole(
        id,
        userId,
        { role: newRole },
        token,
      );
      setMembers((prev) =>
        prev.map((m) =>
          m.user_id === userId ? { ...m, role: updated.role } : m,
        ),
      );
    } catch (err) {
      alert(err.message || "Failed to update role");
    }
  }

  async function handleRemoveMember(userId) {
    if (!confirm("Are you sure you want to remove this member?")) return;
    try {
      await api.removeCampaignMember(id, userId, token);
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    } catch (err) {
      alert(err.message || "Failed to remove member");
    }
  }

  function handleOpenEditModal() {
    if (!campaign) return;
    setEditFormData({
      title: campaign.title || "",
      description: campaign.description || "",
      deadline: campaign.deadline ? campaign.deadline.split("T")[0] : "",
    });
    setEditError("");
    setEditSuccess("");
    setIsEditingCampaign(true);
  }

  function handleCloseEditModal() {
    setIsEditingCampaign(false);
    setEditFormData({ title: "", description: "", deadline: "" });
    setEditError("");
    setEditSuccess("");
  }

  async function handleSaveEdit() {
    setEditError("");

    // Validate form
    if (!editFormData.title.trim()) {
      setEditError("Title is required");
      return;
    }
    if (editFormData.title.length > 100) {
      setEditError("Title must be at most 100 characters");
      return;
    }
    if (editFormData.description.length > 1000) {
      setEditError("Description must be at most 1000 characters");
      return;
    }
    if (editFormData.deadline) {
      const deadlineDate = new Date(editFormData.deadline);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      deadlineDate.setHours(0, 0, 0, 0);
      if (deadlineDate < today) {
        setEditError("Deadline cannot be in the past");
        return;
      }
    }

    try {
      setEditLoading(true);
      const updates = {};
      if (editFormData.title !== campaign.title)
        updates.title = editFormData.title;
      if (editFormData.description !== campaign.description)
        updates.description = editFormData.description;
      if (
        editFormData.deadline !==
        (campaign.deadline ? campaign.deadline.split("T")[0] : "")
      ) {
        updates.deadline = editFormData.deadline || null;
      }

      if (Object.keys(updates).length === 0) {
        setEditError("No changes to save");
        setEditLoading(false);
        return;
      }

      const updated = await api.updateCampaign(campaign.id, updates, token);
      setCampaign(updated);
      setIsEditingCampaign(false);
      setEditFormData({ title: "", description: "", deadline: "" });
      setEditSuccess("Campaign updated successfully!");
      setTimeout(() => setEditSuccess(""), 3000);
    } catch (err) {
      setEditError(err.message || "Failed to update campaign");
    } finally {
      setEditLoading(false);
    }
  }

  async function handleInitiateRefund() {
    setRefundBusy(true);
    setRefundError("");
    setRefundSuccess("");
    try {
      const initRes = await api.initiateRefund(campaign.id);
      const unsignedXdr = initRes.unsigned_xdr;

      let signedXdr = unsignedXdr;
      if (user?.wallet_type === "freighter") {
        const network = await getNetwork();
        if (network?.error) throw new Error("Could not read Freighter network");

        const signed = await signTransaction(unsignedXdr, {
          networkPassphrase: network?.networkPassphrase,
          address: user?.wallet_public_key,
        });
        if (signed?.error) throw new Error(signed.error?.message || "Freighter signing failed");
        if (!signed?.signedTxXdr) throw new Error("Freighter did not return a signed transaction");

        const approveRes = await api.approveRefundCreator(campaign.id, { signed_xdr: signed.signedTxXdr });
        signedXdr = approveRes.signed_xdr;
      } else {
        const approveRes = await api.approveRefundCreator(campaign.id, {});
        signedXdr = approveRes.signed_xdr;
      }

      let isPlatformApprover = false;
      try {
        const capRes = await api.getWithdrawalCapabilities();
        if (capRes.can_approve_platform) {
          isPlatformApprover = true;
        }
      } catch (err) {
        // ignore
      }

      if (isPlatformApprover) {
        await api.approveRefundPlatform(campaign.id);
        setRefundSuccess("Campaign contributions successfully refunded!");
      } else {
        setRefundSuccess("Refund signed by creator. Awaiting platform release.");
      }

      const updatedCampaign = await api.getCampaign(campaign.id);
      setCampaign(updatedCampaign);
    } catch (err) {
      setRefundError(err.message || "Failed to initiate refund.");
    } finally {
      setRefundBusy(false);
    }
  }
  async function handleDeleteCampaign() {
    setDeleteError("");
    if (!campaign) return;

    // Check if confirmation matches campaign title
    if (deleteConfirmation !== campaign.title) {
      setDeleteError("Confirmation does not match campaign title");
      return;
    }

    try {
      setDeleteLoading(true);
      await api.deleteCampaign(campaign.id, token);
      setShowDeleteDialog(false);
      setDeleteConfirmation("");
      // Redirect to home after successful deletion
      window.location.href = "/";
    } catch (err) {
      setDeleteError(err.message || "Failed to delete campaign");
    } finally {
      setDeleteLoading(false);
    }
  }

  useEffect(() => {
    if (!campaign) return;
    document.title = `${campaign.title} | CrowdPay`;

    // Basic meta tag updates (SPA approach)
    const updateMeta = (name, content, property = false) => {
      let el = document.querySelector(
        property ? `meta[property="${name}"]` : `meta[name="${name}"]`,
      );
      if (!el) {
        el = document.createElement("meta");
        if (property) el.setAttribute("property", name);
        else el.setAttribute("name", name);
        document.head.appendChild(el);
      }
      el.setAttribute("content", content);
    };

    updateMeta("description", campaign.description || "");
    updateMeta("og:title", campaign.title, true);
    updateMeta("og:description", campaign.description || "", true);
    updateMeta("og:url", window.location.href, true);
    if (campaign.cover_image_url) {
      updateMeta("og:image", campaign.cover_image_url, true);
      updateMeta("twitter:image", campaign.cover_image_url);
    }
    updateMeta("twitter:card", "summary_large_image");
    updateMeta("twitter:title", campaign.title);
    updateMeta("twitter:description", campaign.description || "");
  }, [campaign]);

  if (loadError && !campaign) {
    return (
      <main className="container page-narrow" style={{ paddingTop: "2.5rem" }}>
        <p className="alert alert--error" role="alert">
          {loadError}
        </p>
        <Link to="/" style={{ color: "var(--color-accent)", fontWeight: 600 }}>
          ← Back home
        </Link>
      </main>
    );
  }

  if (!campaign) {
    return <CampaignDetailSkeleton />;
  }

  const pct = Math.min(
    100,
    (campaign.raised_amount / campaign.target_amount) * 100,
  ).toFixed(1);
  const currentUserId = user?.id || user?.userId;
  const canPostUpdate =
    currentUserId && String(campaign.creator_id) === String(currentUserId);
  const campaignUrl = `${window.location.origin}/campaigns/${id}`;
  const embedCode = `<iframe src="${window.location.origin}/widget/campaigns/${id}" width="320" height="120" frameborder="0" title="CrowdPay campaign"></iframe>`;

  function canEditUpdate(update) {
    return (
      Date.now() - new Date(update.created_at).getTime() <= 24 * 60 * 60 * 1000
    );
  }

  function startEditUpdate(update) {
    setEditingUpdateId(update.id);
    setUpdateForm({ title: update.title, body: update.body });
    setUpdatesError("");
  }

  function cancelUpdateEdit() {
    setEditingUpdateId(null);
    setUpdateForm({ title: "", body: "" });
    setUpdatesError("");
  }

  async function handleFreighterContribute() {
    try {
      const connected = await isConnected().then((r) => r?.isConnected ?? r).catch(() => false);
      if (!connected) {
        window.open('https://www.freighter.app/', '_blank', 'noopener,noreferrer');
        return;
      }
      setFreighterGuestMode(true);
      setShowModal(true);
    } catch {
      window.open('https://www.freighter.app/', '_blank', 'noopener,noreferrer');
    }
  }

  async function submitUpdate(e) {
    e.preventDefault();
    setUpdatesError("");
    setUpdateBusy(true);

    try {
      if (editingUpdateId) {
        const updated = await api.updateCampaignUpdate(
          campaign.id,
          editingUpdateId,
          { title: updateForm.title.trim(), body: updateForm.body.trim() },
        );

        setUpdates((prev) =>
          prev.map((item) => (item.id === editingUpdateId ? updated : item)),
        );
        setEditingUpdateId(null);
      } else {
        const created = await api.postCampaignUpdate(campaign.id, {
          title: updateForm.title.trim(),
          body: updateForm.body.trim(),
        });

        setUpdates((prev) => [created, ...prev]);
      }

      setUpdateForm({ title: "", body: "" });
    } catch (err) {
      setUpdatesError(err.message || "Could not save update");
    } finally {
      setUpdateBusy(false);
    }
  }

  async function deleteUpdate(updateId) {
    if (!confirm("Delete this campaign update?")) return;

    setUpdatesError("");
    try {
      await api.deleteCampaignUpdate(campaign.id, updateId);
      setUpdates((prev) => prev.filter((item) => item.id !== updateId));
    } catch (err) {
      setUpdatesError(err.message || "Could not delete update");
    }
  }
  return (
    <main
      className="container"
      style={{ paddingTop: "2.5rem", paddingBottom: "4rem", maxWidth: "760px" }}
    >
      {showCreatedBanner && (
        <div
          className="alert alert--success"
          style={{ marginBottom: "1.25rem" }}
          role="status"
        >
          <strong>Campaign is live.</strong> Share the link — contributors can
          fund in XLM or USDC when conversion paths are available.
          <button
            type="button"
            onClick={() => setShowCreatedBanner(false)}
            style={{
              marginLeft: "0.5rem",
              background: "transparent",
              color: "var(--color-success-text)",
              textDecoration: "underline",
              fontWeight: 600,
              padding: 0,
              minHeight: "auto",
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {coverUploadError && (
        <div
          className="alert alert--warning"
          style={{ marginBottom: "1.25rem" }}
          role="status"
        >
          <strong>Cover image upload failed:</strong> {coverUploadError}
        </div>
      )}
      {campaign.status === "funded" && (
        <div
          className="alert alert--success"
          style={{ marginBottom: "1.25rem" }}
          role="status"
        >
          <strong>Goal reached.</strong> This campaign has met its funding
          target. Contributions may still be open until the creator closes the
          campaign.
        </div>
      )}
      {campaign.status === "failed" && (
        <div
          className="alert alert--error"
          style={{ marginBottom: "1.25rem" }}
          role="status"
        >
          <strong>Campaign ended.</strong> This campaign did not reach its goal.
          Contributions are closed and refunds can be requested.
        </div>
      )}
      {campaign.status === "refunded" && (
        <div
          className="alert alert--success"
          style={{ marginBottom: "1.25rem" }}
          role="status"
        >
          <strong>Campaign refunded.</strong> This campaign was refunded — all contributions have been returned to their original senders.
        </div>
      )}
      {campaign.status === "failed" &&
        user &&
        user.id === campaign.creator_id && (
          <div
            style={{
              background: "var(--color-bg-card, #1e1e2f)",
              border: "1px solid var(--color-border-light)",
              borderRadius: "10px",
              padding: "1.1rem 1.25rem",
              marginBottom: "1.25rem",
            }}
          >
            <p
              style={{
                margin: "0 0 0.75rem",
                fontSize: "0.9rem",
                color: "var(--color-text-secondary)",
                lineHeight: 1.55,
              }}
            >
              This campaign did not reach its goal. You can refund all
              contributors — this will build and sign a Stellar transaction that
              returns each contributor's exact amount.
            </p>
            {refundError && (
              <p
                className="alert alert--error"
                style={{ marginBottom: "0.75rem", fontSize: "0.875rem" }}
                role="alert"
              >
                {refundError}
              </p>
            )}
            {refundSuccess && (
              <p
                className="alert alert--success"
                style={{ marginBottom: "0.75rem", fontSize: "0.875rem" }}
                role="status"
              >
                {refundSuccess}
              </p>
            )}
            <button
              id="btn-refund-contributors"
              type="button"
              className="btn-primary"
              disabled={refundBusy}
              onClick={handleInitiateRefund}
              style={{
                background: refundBusy ? undefined : "#dc2626",
                borderColor: refundBusy ? undefined : "#dc2626",
                fontSize: "0.9rem",
              }}
            >
              {refundBusy ? "Processing refund…" : "Refund contributors"}
            </button>
          </div>
        )}
      {campaign.creator_kyc_status !== "verified" && (
        <div
          className="alert alert--warning"
          style={{ marginBottom: "1.25rem" }}
          role="status"
        >
          <strong>Legacy campaign:</strong> this campaign was created before
          creator identity verification was required.
        </div>
      )}
      {editSuccess && (
        <div
          className="alert alert--success"
          style={{ marginBottom: "1.25rem" }}
          role="status"
        >
          {editSuccess}
        </div>
      )}
      {campaign.cover_image_url && (
        <img
          src={campaign.cover_image_url}
          alt={campaign.title}
          style={styles.detailCoverImage}
        />
      )}
      {!campaign.cover_image_url && (
        <div style={styles.detailCoverPlaceholder} aria-hidden="true">
          <span style={styles.detailCoverPlaceholderText}>
            No campaign image yet
          </span>
        </div>
      )}
      <div style={styles.header}>
        <div style={styles.badgeRow}>
          <span style={styles.asset}>{campaign.asset_type}</span>
          <CampaignStatusBadge status={campaign.status} />
          <VerificationBadge status={campaign.creator_kyc_status} />
        </div>
        <h1 style={styles.title}>{campaign.title}</h1>
        {campaign.creator_name && (
          <p style={styles.creator}>by {campaign.creator_name}</p>
        )}
        <p style={styles.desc}>{campaign.description}</p>
      </div>

      <div style={styles.card}>
        <div style={styles.amounts}>
          <div>
            <div style={styles.big}>
              {Number(campaign.raised_amount).toLocaleString()}{" "}
              {campaign.asset_type}
            </div>
            <div style={styles.small}>
              raised of {Number(campaign.target_amount).toLocaleString()} goal
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={styles.big}>{pct}%</div>
            <div style={styles.small}>
              funded by <strong>{campaign.contributor_count || 0}</strong>{" "}
              backers
            </div>
          </div>
        </div>
        <div
          role="progressbar"
          className="campaign-progress-bar"
          aria-valuenow={Number(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pct}% of goal raised`}
          style={styles.bar}
        >
          <div
            style={{
              ...styles.fill,
              background: progressColor(parseFloat(pct), campaign.status),
              width: `${pct}%`,
            }}
            aria-hidden="true"
          />
        </div>

        {campaign.status === 'refunded' ? (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
            This campaign has been <strong>refunded</strong>. All contributions were returned to their original senders.
          </p>
        ) : ['failed', 'closed', 'withdrawn'].includes(campaign.status) ? (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
            Contributions are closed while this campaign is{' '}
            <strong>{campaign.status}</strong>.
          </p>
        ) : (
          user ? (
            <button
              type="button"
              className="btn-primary"
              style={styles.cta}
              ref={contributeBtnRef}
              aria-label={`Contribute to ${campaign.title}`}
              onClick={() => setShowModal(true)}
            >
              Contribute
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              <Link
                to="/login"
                state={{ from: `/campaigns/${id}` }}
                className="btn-primary"
                style={{ ...styles.cta, textAlign: 'center', textDecoration: 'none', display: 'block' }}
              >
                Log in to contribute
              </Link>
              <button
                type="button"
                className="btn-secondary"
                style={styles.cta}
                onClick={handleFreighterContribute}
              >
                Contribute with Freighter
              </button>
            </div>
          )
        )}

        {user && (
          <button
            type="button"
            className="btn-secondary"
            style={{ ...styles.cta, marginTop: "0.75rem" }}
            onClick={handleClone}
          >
            Clone campaign
          </button>
        )}
      </div>

      <div
        data-no-print
        style={{
          display: "flex",
          gap: "0.65rem",
          marginBottom: "1.75rem",
          flexWrap: "wrap",
        }}
      >
        {navigator.share && (
          <button
            type="button"
            className="btn-secondary"
            style={{
              flex: 1,
              fontSize: "0.85rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.5rem",
            }}
            onClick={async () => {
              try {
                await navigator.share({
                  title: campaign.title,
                  text: campaign.description,
                  url: window.location.href,
                });
              } catch (err) {
                // User cancelled share or error occurred
                if (err.name !== "AbortError") {
                  console.error("Share failed:", err);
                }
              }
            }}
          >
            Share
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          style={{
            flex: 1,
            fontSize: "0.85rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
          }}
          onClick={() => {
            const text = encodeURIComponent(
              `I just backed ${campaign.title} on CrowdPay — ${pct}% funded with ${campaign.contributor_count || 0} backers. Join me: ${window.location.href}`,
            );
            window.open(
              `https://twitter.com/intent/tweet?text=${text}`,
              "_blank",
            );
          }}
        >
          Share on X
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{
            flex: 1,
            fontSize: "0.85rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
          }}
          onClick={() => {
            const text = encodeURIComponent(
              `I just backed ${campaign.title} on CrowdPay — ${pct}% funded with ${campaign.contributor_count || 0} backers. Join me: ${window.location.href}`,
            );
            window.open(`https://wa.me/?text=${text}`, "_blank");
          }}
        >
          WhatsApp
        </button>
        <div style={{ position: "relative", flex: 1 }}>
          <button
            type="button"
            className="btn-secondary"
            style={{
              fontSize: "0.85rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.5rem",
              width: "100%",
              background: linkCopied ? "var(--color-success-text)" : undefined,
              borderColor: linkCopied ? "var(--color-success-text)" : undefined,
              color: linkCopied ? "#fff" : undefined,
              transition: "all 0.2s ease",
            }}
            onClick={() => {
              navigator.clipboard.writeText(window.location.href);
              setLinkCopied(true);
              setTimeout(() => setLinkCopied(false), 2000);
            }}
          >
            {linkCopied ? "Copied!" : "Copy link"}
          </button>
        </div>
      </div>

      {/* Edit campaign button - visible only to creator */}
      {user && campaign && user.userId === campaign.creator_id && ['active', 'funded'].includes(campaign.status) && (
        <div
          data-no-print
          style={{
            display: "flex",
            gap: "0.65rem",
            marginBottom: "1.75rem",
          }}
        >

            <button
              type="button"
              className="btn-secondary"
              style={{
                flex: 1,
                fontSize: "0.85rem",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.5rem",
              }}
              onClick={handleOpenEditModal}
            >
              Edit Campaign
            </button>
            {campaign.status === "active" && !hasPendingWithdrawal && (
              <button
                type="button"
                className="btn-secondary"
                style={{
                  color: "#dc2626",
                  fontSize: "0.85rem",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.5rem",
                }}
                onClick={() => setShowDeleteDialog(true)}
              >
                Delete campaign
              </button>
            )}
          </div>
        )}

      <div style={styles.walletInfo}>
        <span style={styles.walletLabel}>Campaign wallet</span>
        <code style={styles.walletKey}>{campaign.wallet_public_key}</code>
      </div>

      <div style={{ marginBottom: '1.75rem' }}>
        <button type="button" className="btn-secondary" data-no-print onClick={() => setShowQR((v) => !v)}>
          {showQR ? 'Hide QR code' : 'Show QR code'}
        </button>
        <div className="qr-wrapper" style={{ marginTop: '1rem', display: showQR ? 'flex' : 'none', justifyContent: 'center' }}>
          <CampaignQRCode url={`${window.location.origin}/campaigns/${id}`} size={200} />
        </div>
        {showQR && (
          <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center' }}>
            <CampaignQRCode url={campaignUrl} size={200} />
          </div>
        )}
      </div>

      <details style={{ ...styles.card, marginTop: "-0.75rem" }}>
        <summary style={styles.embedSummary}>
          Embed on your site
        </summary>
        <pre style={{ ...styles.embedCode, marginTop: "0.75rem" }}>
          {embedCode}
        </pre>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(embedCode).then(() => {
              setEmbedCopied(true);
              setTimeout(() => setEmbedCopied(false), 2000);
            });
          }}
          className="btn-secondary"
          style={{ marginTop: "0.75rem", fontSize: "0.85rem", minHeight: "auto" }}
        >
          {embedCopied ? "Copied!" : "Copy snippet"}
        </button>
      </details>

      {/* Report a problem — visible to contributors who have backed this campaign */}
      {user &&
        user.wallet_public_key &&
        contributions?.some(
          (c) => c.sender_public_key && c.sender_public_key === user.wallet_public_key,
        ) &&
        campaign.creator_id !== user.id && (
          <div style={{ marginBottom: "1.25rem" }} data-no-print>
            {disputeSubmitted ? (
              <p className="alert alert--success" role="status">
                Your dispute has been submitted. The platform team will review
                it shortly.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setShowDisputeModal(true)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--color-status-error)",
                  fontWeight: 600,
                  fontSize: "0.9rem",
                  cursor: "pointer",
                  padding: 0,
                  textDecoration: "underline",
                }}
              >
                ⚠ Report a problem with this campaign
              </button>
            )}
          </div>
        )}
      {canPostUpdate && (
        <div style={styles.card} data-no-print>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "1rem",
            }}
          >
            <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>
              Embed this campaign
            </h3>
            <button
              type="button"
              onClick={() => setShowEmbedSection(!showEmbedSection)}
              style={{
                background: "transparent",
                color: "var(--color-accent)",
                border: "1px solid var(--color-accent)",
                padding: "0.4rem 0.8rem",
                fontSize: "0.85rem",
                minHeight: "auto",
              }}
            >
              {showEmbedSection ? "Hide" : "Show"}
            </button>
          </div>

          {showEmbedSection && (
            <>
              <p
                style={{
                  fontSize: "0.85rem",
                  color: "var(--color-text-hint)",
                  marginBottom: "1rem",
                  lineHeight: 1.5,
                }}
              >
                Add this embed code to your website or blog to display a live
                funding widget for this campaign.
              </p>

              <div style={{ marginBottom: "1rem" }}>
                <label
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    color: "var(--color-text-hint)",
                    display: "block",
                    marginBottom: "0.5rem",
                  }}
                >
                  Embed code
                </label>
                <div style={{ position: "relative" }}>
                  <pre style={styles.embedCode}>
                    {`<iframe src="${window.location.origin}/embed/campaigns/${campaign.id}" \n        width="480" height="280" frameborder="0">\n</iframe>`}
                  </pre>
                  <button
                    type="button"
                    onClick={() => {
                      const code = `<iframe src="${window.location.origin}/embed/campaigns/${campaign.id}" width="480" height="280" frameborder="0"></iframe>`;
                      navigator.clipboard.writeText(code).then(() => {
                        setEmbedCopied(true);
                        setTimeout(() => setEmbedCopied(false), 2000);
                      });
                    }}
                    style={{
                      position: "absolute",
                      top: "0.5rem",
                      right: "0.5rem",
                      background: embedCopied
                        ? "var(--color-success-text)"
                        : "var(--color-accent)",
                      color: "#fff",
                      padding: "0.4rem 0.8rem",
                      fontSize: "0.8rem",
                      minHeight: "auto",
                    }}
                  >
                    {embedCopied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>

              <div>
                <label
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    color: "var(--color-text-hint)",
                    display: "block",
                    marginBottom: "0.5rem",
                  }}
                >
                  Preview
                </label>
                <div style={styles.embedPreview}>
                  <iframe
                    src={`/embed/campaigns/${campaign.id}`}
                    width="100%"
                    height="280"
                    frameBorder="0"
                    title="Campaign embed preview"
                    style={{
                      border: "1px solid var(--color-border-light)",
                      borderRadius: "6px",
                    }}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {token && (
        <div id="withdrawals" data-no-print>
        <WithdrawalsSection
          campaign={campaign}
          milestones={milestones}
          user={user}
          token={token}
          onReleased={() => {
            api
              .getCampaign(id)
              .then(setCampaign)
              .catch(() => {});
            api
              .getMilestones(id)
              .then(setMilestones)
              .catch(() => {});
          }}
        />
        </div>
      )}

      <TransactionHistory
        campaignId={campaign.id}
        isCreator={!!(user?.id && campaign.creator_id === user.id)}
      />

      <MilestoneTracker
        milestones={milestones}
        assetType={campaign.asset_type}
      />
      {isOwner && (
        <div style={{ marginBottom: "2rem" }} data-no-print>
          <h2 style={styles.sectionTitle}>Team Management</h2>
          <div className="campaign-card" style={{ marginBottom: "1.5rem" }}>
            <strong style={{ marginBottom: "0.75rem", display: "block" }}>
              Invite Team Member
            </strong>
            <form
              onSubmit={handleInviteSubmit}
              style={{
                display: "flex",
                gap: "0.75rem",
                flexWrap: "wrap",
                alignItems: "flex-end",
              }}
            >
              <div style={{ flex: "1 1 250px" }}>
                <label
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--color-text-hint)",
                    display: "block",
                    marginBottom: "0.25rem",
                  }}
                >
                  Email
                </label>
                <input
                  type="email"
                  placeholder="member@example.com"
                  value={inviteForm.email}
                  onChange={(e) =>
                    setInviteForm((s) => ({ ...s, email: e.target.value }))
                  }
                  required
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ width: "120px" }}>
                <label
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--color-text-hint)",
                    display: "block",
                    marginBottom: "0.25rem",
                  }}
                >
                  Role
                </label>
                <select
                  value={inviteForm.role}
                  onChange={(e) =>
                    setInviteForm((s) => ({ ...s, role: e.target.value }))
                  }
                  style={{ width: "100%", padding: "0.5rem" }}
                >
                  <option value="viewer">Viewer</option>
                  <option value="manager">Manager</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
              <button
                type="submit"
                className="btn-primary"
                disabled={inviteBusy}
                style={{ height: "38px" }}
              >
                {inviteBusy ? "Sending…" : "Invite"}
              </button>
            </form>
            {inviteError && (
              <p
                className="alert alert--error"
                style={{ marginTop: "0.75rem" }}
              >
                {inviteError}
              </p>
            )}
            {inviteSuccess && (
              <p
                className="alert alert--success"
                style={{ marginTop: "0.75rem" }}
              >
                Invitation sent!
              </p>
            )}
          </div>

          <div className="campaign-card">
            <strong style={{ marginBottom: "0.75rem", display: "block" }}>
              Current Team
            </strong>
            {members.length === 0 ? (
              <p style={{ color: "var(--color-text-muted)" }}>
                No team members yet.
              </p>
            ) : (
              <div style={{ display: "grid", gap: "0.75rem" }}>
                {members.map((member) => (
                  <div
                    key={member.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "1rem",
                      borderBottom: "1px solid var(--color-border-lighter)",
                      paddingBottom: "0.5rem",
                    }}
                  >
                    <div>
                      <span style={{ fontWeight: 600 }}>{member.email}</span>
                      {member.user_name && (
                        <span
                          style={{
                            color: "var(--color-text-hint)",
                            fontSize: "0.85rem",
                            marginLeft: "0.5rem",
                          }}
                        >
                          ({member.user_name})
                        </span>
                      )}
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: member.accepted_at
                            ? "var(--color-success-text)"
                            : "var(--color-warning-text)",
                          fontWeight: 600,
                        }}
                      >
                        {member.accepted_at ? "Accepted" : "Pending"}
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "center",
                      }}
                    >
                      <select
                        value={member.role}
                        onChange={(e) =>
                          handleRoleChange(member.user_id, e.target.value)
                        }
                        disabled={
                          !member.user_id ||
                          String(member.user_id) === String(user?.id)
                        }
                        style={{ padding: "0.25rem", fontSize: "0.85rem" }}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="manager">Manager</option>
                        <option value="owner">Owner</option>
                      </select>
                      <button
                        className="btn-secondary"
                        onClick={() => handleRemoveMember(member.user_id)}
                        disabled={String(member.user_id) === String(user?.id)}
                        style={{
                          padding: "0.25rem 0.5rem",
                          fontSize: "0.85rem",
                          color: "var(--color-status-error)",
                          borderColor: "var(--color-status-error)",
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <h2 style={styles.sectionTitle}>Updates ({updates.length})</h2>
      {canPostUpdate && (
        <form
          onSubmit={submitUpdate}
          className="campaign-card"
          style={{ marginBottom: "1rem" }}
          data-no-print
        >
          <strong style={{ marginBottom: "0.5rem", display: "block" }}>
            {editingUpdateId ? "Edit update" : "Post update"}
          </strong>
          <input
            placeholder="Update title"
            value={updateForm.title}
            onChange={(e) =>
              setUpdateForm((s) => ({ ...s, title: e.target.value }))
            }
            required
            style={{ marginBottom: "0.5rem" }}
          />
          <textarea
            placeholder="Write markdown update..."
            value={updateForm.body}
            onChange={(e) =>
              setUpdateForm((s) => ({ ...s, body: e.target.value }))
            }
            rows={4}
            required
          />
          {updatesError && (
            <div style={{ color: "var(--color-status-error)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
              {updatesError}
            </div>
          )}
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button
              type="submit"
              className="btn-primary"
              disabled={updateBusy}
            >
              {updateBusy ? "Saving..." : editingUpdateId ? "Save changes" : "Post"}
            </button>
            {editingUpdateId && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setEditingUpdateId(null);
                  setUpdateForm({ title: "", body: "" });
                  setUpdatesError("");
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      {updates.length === 0 ? (
        <p style={{ color: "var(--color-text-muted)", marginBottom: "1rem" }}>
          No updates yet — the creator hasn't posted anything.
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gap: "0.75rem",
            marginBottom: "1.25rem",
          }}
        >
          {updates.map((update) => (
            <article key={update.id} className="campaign-card">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <strong>{update.title}</strong>
                <span
                  style={{
                    color: "var(--color-text-hint)",
                    fontSize: "0.85rem",
                  }}
                >
                  {update.author_name} •{" "}
                  <RelativeTime date={update.created_at} />
                </span>
              </div>
              <div
                style={{
                  marginTop: "0.5rem",
                  color: "var(--color-text-primary)",
                  lineHeight: 1.5,
                }}
                dangerouslySetInnerHTML={{
                  __html: markdownToHtml(update.body),
                }}
              />

              {canPostUpdate && (
                <div
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    marginTop: "0.75rem",
                  }}
                >
                  {canEditUpdate(update) && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => startEditUpdate(update)}
                      style={{
                        fontSize: "0.85rem",
                        padding: "0.4rem 0.75rem",
                      }}
                    >
                      Edit
                    </button>
                  )}

                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => deleteUpdate(update.id)}
                    style={{
                      fontSize: "0.85rem",
                      padding: "0.4rem 0.75rem",
                      color: "var(--color-status-error)",
                      borderColor: "var(--color-status-error)",
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}


      {/* Analytics Section */}
      {analytics && (
        <div style={{ marginBottom: "2rem" }}>
          <h2 style={styles.sectionTitle}>Analytics</h2>
          {!analytics.dailyTotals || analytics.dailyTotals.length === 0 ? (
            <p style={{ color: "var(--color-text-muted)" }}>
              No analytics data available yet.
            </p>
          ) : (
            <div style={{ display: "grid", gap: "1.5rem" }}>
              <div className="campaign-card">
                <strong style={{ display: "block", marginBottom: "1rem" }}>
                  Contributions (Last 30 Days)
                </strong>
                <svg
                  width="100%"
                  height={150}
                  viewBox={`0 0 600 150`}
                  preserveAspectRatio="none"
                >
                  {analytics.dailyTotals.map((day, i) => {
                    const maxAmount = Math.max(
                      ...analytics.dailyTotals.map(
                        (d) => Number(d.total_amount) || 0,
                      ),
                      1,
                    );
                    const barWidth =
                      600 / Math.max(analytics.dailyTotals.length, 1);
                    const barHeight = Math.max(
                      5,
                      (Number(day.total_amount) / maxAmount) * 150,
                    );
                    const y = 150 - barHeight;
                    const x = i * barWidth;
                    return (
                      <g key={i}>
                        <title>{`${new Date(day.day).toLocaleDateString()}: ${day.total_amount} ${day.asset}`}</title>
                        <rect
                          x={x}
                          y={y}
                          width={Math.max(barWidth - 2, 2)}
                          height={barHeight}
                          fill="var(--color-accent)"
                          rx="2"
                        />
                      </g>
                    );
                  })}
                </svg>
              </div>

              <div className="campaign-card">
                <strong style={{ display: "block", marginBottom: "1rem" }}>
                  Asset Breakdown
                </strong>
                {analytics.assetBreakdown.map((asset) => (
                  <div
                    key={asset.paid_with}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <span>{asset.paid_with}</span>
                    <strong>{asset.total_sent}</strong>
                  </div>
                ))}
              </div>

              <div className="campaign-card">
                <strong style={{ display: "block", marginBottom: "1rem" }}>
                  Top Contributors
                </strong>
                {analytics.topContributors.map((c, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: "0.5rem",
                      fontFamily: "monospace",
                    }}
                  >
                    <span>
                      {c.sender_public_key.slice(0, 4)}...
                      {c.sender_public_key.slice(-4)}
                    </span>
                    <span>
                      {c.total} ({c.times} contributions)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <h2 style={styles.sectionTitle}>
        Backer Wall {contributions !== null ? `(${totalContributions})` : ""}
        {isLive && (
          <span style={styles.liveIndicator} title="Live updates active">
            <span style={styles.liveDot} />
            Live
          </span>
        )}
      </h2>
      {contributions === null ? (
        <ContributionListSkeleton />
      ) : contributions.length === 0 ? (
        <div style={styles.emptyBackers}>
          <p>Be the first to back this!</p>
          <p
            style={{ fontSize: "0.9rem", color: "var(--color-text-secondary)", marginTop: "0.25rem" }}
          >
            Every contribution counts towards making this goal a reality.
          </p>
        </div>
      ) : (
        <>
          <div style={styles.list} className="contributions-list">
            {contributions.map((c) => (
              <ContributionRow key={c.id} c={c} />
            ))}
          </div>
          {totalContributions > 10 && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowAll((prev) => !prev)}
                style={{ padding: '0.5rem 1.5rem', fontSize: '0.9rem', cursor: 'pointer' }}
              >
                {showAll ? "Show less" : `Show all (${totalContributions})`}
              </button>
            </div>
          )}
        </>
      )}

      {showModal && (
        <ContributeModal
          campaign={campaign}
          guestFreighterMode={freighterGuestMode}
          onClose={() => {
            setShowModal(false);
            setFreighterGuestMode(false);
            contributeBtnRef.current?.focus();
          }}
          onSuccess={() => setContributed((v) => !v)}
        />
      )}
      {showDisputeModal && (
        <DisputeModal
          campaign={campaign}
          onClose={() => setShowDisputeModal(false)}
          onSubmitted={() => setDisputeSubmitted(true)}
        />
      )}

      {/* Edit Campaign Modal */}
      {isEditingCampaign && campaign && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={handleCloseEditModal}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: "12px",
              padding: "2rem",
              maxWidth: "500px",
              width: "90%",
              maxHeight: "90vh",
              overflowY: "auto",
              boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              style={{
                marginTop: 0,
                marginBottom: "1.5rem",
                fontSize: "1.5rem",
              }}
            >
              Edit Campaign
            </h2>

            {editError && (
              <p
                style={{
                  color: "#d32f2f",
                  marginBottom: "1rem",
                  padding: "0.75rem",
                  background: "#ffebee",
                  borderRadius: "6px",
                }}
              >
                {editError}
              </p>
            )}

            <div style={{ marginBottom: "1.5rem" }}>
              <label
                style={{
                  display: "block",
                  fontWeight: 600,
                  marginBottom: "0.5rem",
                }}
              >
                Title
              </label>
              <input
                type="text"
                value={editFormData.title}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, title: e.target.value })
                }
                maxLength={100}
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  border: "1px solid #ddd",
                  borderRadius: "6px",
                  fontSize: "1rem",
                  boxSizing: "border-box",
                }}
              />
              <p
                style={{
                  fontSize: "0.85rem",
                  color: "#888",
                  margin: "0.25rem 0 0",
                }}
              >
                {editFormData.title.length}/100
              </p>
            </div>

            <div style={{ marginBottom: "1.5rem" }}>
              <label
                style={{
                  display: "block",
                  fontWeight: 600,
                  marginBottom: "0.5rem",
                }}
              >
                Description
              </label>
              <textarea
                value={editFormData.description}
                onChange={(e) =>
                  setEditFormData({
                    ...editFormData,
                    description: e.target.value,
                  })
                }
                maxLength={1000}
                rows={5}
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  border: "1px solid #ddd",
                  borderRadius: "6px",
                  fontSize: "1rem",
                  fontFamily: "inherit",
                  boxSizing: "border-box",
                }}
              />
              <p
                style={{
                  fontSize: "0.85rem",
                  color: "#888",
                  margin: "0.25rem 0 0",
                }}
              >
                {editFormData.description.length}/1000
              </p>
            </div>

            <div style={{ marginBottom: "1.5rem" }}>
              <label
                style={{
                  display: "block",
                  fontWeight: 600,
                  marginBottom: "0.5rem",
                }}
              >
                Deadline (optional)
              </label>
              <input
                type="date"
                value={editFormData.deadline}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, deadline: e.target.value })
                }
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  border: "1px solid #ddd",
                  borderRadius: "6px",
                  fontSize: "1rem",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                gap: "1rem",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={handleCloseEditModal}
                disabled={editLoading}
                style={{ opacity: editLoading ? 0.6 : 1 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSaveEdit}
                disabled={editLoading}
                style={{ opacity: editLoading ? 0.6 : 1 }}
              >
                {editLoading ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Campaign Confirmation Dialog */}
      {showDeleteDialog && campaign && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "var(--color-surface)",
              borderRadius: "8px",
              padding: "2rem",
              maxWidth: "500px",
              width: "90%",
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
            }}
          >
            <h2
              style={{
                fontSize: "1.5rem",
                fontWeight: 700,
                marginBottom: "1rem",
                color: "var(--color-text-primary)",
              }}
            >
              Delete Campaign
            </h2>
            <p
              style={{
                fontSize: "0.95rem",
                color: "var(--color-text-secondary)",
                marginBottom: "1.5rem",
                lineHeight: 1.5,
              }}
            >
              Are you sure you want to delete this campaign? This action cannot
              be undone. All contribution and withdrawal history will be
              preserved, but the campaign will no longer be visible to the
              public.
            </p>
            <div style={{ marginBottom: "1.5rem" }}>
              <label
                style={{
                  display: "block",
                  fontWeight: 600,
                  marginBottom: "0.5rem",
                  fontSize: "0.9rem",
                  color: "var(--color-text-primary)",
                }}
              >
                Type the campaign title to confirm:
              </label>
              <input
                type="text"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
                placeholder={campaign.title}
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  border: "1px solid var(--color-border)",
                  borderRadius: "4px",
                  fontSize: "1rem",
                  boxSizing: "border-box",
                }}
              />
            </div>
            {deleteError && (
              <p
                className="alert alert--error"
                style={{ marginBottom: "1.5rem" }}
              >
                {deleteError}
              </p>
            )}
            <div
              style={{
                display: "flex",
                gap: "1rem",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setShowDeleteDialog(false);
                  setDeleteConfirmation("");
                  setDeleteError("");
                }}
                disabled={deleteLoading}
                style={{ opacity: deleteLoading ? 0.6 : 1 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleDeleteCampaign}
                disabled={
                  deleteLoading || deleteConfirmation !== campaign.title
                }
                style={{
                  opacity:
                    deleteLoading || deleteConfirmation !== campaign.title
                      ? 0.6
                      : 1,
                  background: "#dc2626",
                  borderColor: "#dc2626",
                }}
              >
                {deleteLoading ? "Deleting..." : "Delete Campaign"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

const styles = {
  header: { marginBottom: "1.5rem" },
  badgeRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap",
  },
  asset: {
    background: "#ede9fe",
    color: "#7c3aed",
    fontSize: "0.75rem",
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: "99px",
  },
  title: {
    fontSize: "1.8rem",
    fontWeight: 800,
    margin: "0.5rem 0",
    color: "#111",
  },
  creator: { color: "#666", fontSize: "0.9rem", marginBottom: "0.5rem" },
  desc: { color: "#555", fontSize: "1rem", lineHeight: 1.6 },
  card: {
    background: "#fff",
    border: "1px solid #e5e5e5",
    borderRadius: "10px",
    padding: "1.5rem",
    marginBottom: "1rem",
  },
  amounts: {
    display: "flex",
    justifyContent: "space-between",
    marginBottom: "1rem",
  },
  big: { fontSize: "1.5rem", fontWeight: 800, color: "#111" },
  small: { fontSize: "0.85rem", color: "#888" },
  bar: {
    background: "#f0f0f0",
    borderRadius: "99px",
    height: "8px",
    marginBottom: "1.25rem",
    overflow: "hidden",
  },
  fill: { background: "#7c3aed", height: "100%", borderRadius: "99px" },
  cta: { width: "100%", padding: "0.85rem", fontSize: "1rem" },
  walletInfo: {
    background: "#f8f8f8",
    borderRadius: "8px",
    padding: "0.75rem 1rem",
    marginBottom: "1.75rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  walletLabel: {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#888",
    textTransform: "uppercase",
  },
  walletKey: { fontSize: "0.8rem", color: "#555", wordBreak: "break-all" },
  detailCoverImage: {
    width: "100%",
    borderRadius: "14px",
    marginBottom: "1.5rem",
    objectFit: "cover",
    maxHeight: "360px",
  },
  detailCoverPlaceholder: {
    width: "100%",
    borderRadius: "14px",
    marginBottom: "1.5rem",
    height: "260px",
    background: "linear-gradient(135deg, #ede9fe 0%, #e0e7ff 100%)",
    border: "1px solid #ddd6fe",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  detailCoverPlaceholderText: { color: "#6d28d9", fontWeight: 700 },
  sectionTitle: {
    fontSize: "1.1rem",
    fontWeight: 700,
    marginBottom: "0.75rem",
  },
  list: { display: "flex", flexDirection: "column", gap: "0.5rem" },
  row: {
    display: "flex",
    justifyContent: "space-between",
    background: "#fff",
    border: "1px solid #eee",
    borderRadius: "6px",
    padding: "0.6rem 0.85rem",
  },
  sender: { fontSize: "0.85rem", color: "#555", fontFamily: "monospace" },
  amount: { fontSize: "0.85rem", fontWeight: 600, flexShrink: 0 },
  convHint: { fontSize: "0.72rem", color: "#888", marginTop: "0.15rem" },
  refundTag: {
    marginTop: "0.45rem",
    fontSize: "0.75rem",
    color: "#7c3aed",
    fontWeight: 700,
  },
  liveIndicator: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    marginLeft: "0.5rem",
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "#16a34a",
    verticalAlign: "middle",
  },
  liveDot: {
    display: "inline-block",
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    background: "#16a34a",
    animation: "pulse 1.5s ease-in-out infinite",
  },
  header: { marginBottom: "1.5rem" },
  badgeRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap",
  },
  asset: {
    background: "var(--color-accent-lightest)",
    color: "var(--color-accent)",
    fontSize: "0.75rem",
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: "99px",
  },
  title: {
    fontSize: "1.8rem",
    fontWeight: 800,
    margin: "0.5rem 0",
    color: "var(--color-text-primary)",
  },
  creator: {
    color: "var(--color-text-hint)",
    fontSize: "0.9rem",
    marginBottom: "0.5rem",
  },
  desc: {
    color: "var(--color-text-secondary)",
    fontSize: "1rem",
    lineHeight: 1.6,
  },
  card: {
    background: "var(--color-bg)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "10px",
    padding: "1.5rem",
    marginBottom: "1rem",
  },
  amounts: {
    display: "flex",
    justifyContent: "space-between",
    marginBottom: "1rem",
  },
  big: {
    fontSize: "1.5rem",
    fontWeight: 800,
    color: "var(--color-text-primary)",
  },
  small: { fontSize: "0.85rem", color: "var(--color-text-secondary)" },
  bar: {
    background: "var(--color-surface)",
    borderRadius: "99px",
    height: "8px",
    marginBottom: "1.25rem",
    overflow: "hidden",
  },
  fill: {
    background: "var(--color-accent)",
    height: "100%",
    borderRadius: "99px",
  },
  cta: { width: "100%", padding: "0.85rem", fontSize: "1rem" },
  walletInfo: {
    background: "var(--color-surface)",
    borderRadius: "8px",
    padding: "0.75rem 1rem",
    marginBottom: "1.75rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  walletLabel: {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "var(--color-text-secondary)",
    textTransform: "uppercase",
  },
  walletKey: {
    fontSize: "0.8rem",
    color: "var(--color-text-hint)",
    wordBreak: "break-all",
  },
  detailCoverImage: {
    width: "100%",
    borderRadius: "14px",
    marginBottom: "1.5rem",
    objectFit: "cover",
    maxHeight: "360px",
  },
  sectionTitle: {
    fontSize: "1.1rem",
    fontWeight: 700,
    marginBottom: "0.75rem",
  },
  list: { display: "flex", flexDirection: "column", gap: "0.5rem" },
  row: {
    display: "flex",
    justifyContent: "space-between",
    background: "var(--color-bg)",
    border: "1px solid var(--color-border-lighter)",
    borderRadius: "6px",
    padding: "0.6rem 0.85rem",
  },
  sender: {
    fontSize: "0.85rem",
    color: "var(--color-text-secondary)",
    fontFamily: "monospace",
  },
  amount: { fontSize: "0.85rem", fontWeight: 600, flexShrink: 0 },
  convHint: {
    fontSize: "0.72rem",
    color: "var(--color-text-secondary)",
    marginTop: "0.15rem",
  },
  refundTag: {
    marginTop: "0.45rem",
    fontSize: "0.75rem",
    color: "var(--color-accent)",
    fontWeight: 700,
  },
  liveIndicator: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    marginLeft: "0.5rem",
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "var(--color-success-text)",
    verticalAlign: "middle",
  },
  liveDot: {
    display: "inline-block",
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    background: "var(--color-success-text)",
    animation: "pulse 1.5s ease-in-out infinite",
  },
  embedCode: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "6px",
    padding: "0.75rem",
    fontSize: "0.75rem",
    fontFamily: "monospace",
    color: "var(--color-text-primary)",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    paddingRight: "5rem",
  },
  embedSummary: {
    cursor: "pointer",
    fontSize: "0.85rem",
    color: "var(--color-accent)",
    fontWeight: 600,
  },
  embedPreview: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "6px",
    padding: "0.75rem",
  },
  emptyBackers: {
    padding: "2.5rem 1rem",
    textAlign: "center",
    background: "var(--color-accent-lightest)",
    border: "2px dashed var(--color-accent-lighter)",
    borderRadius: "12px",
    color: "var(--color-accent)",
    fontWeight: 700,
  },
  avatar: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    background: "var(--color-accent-lightest)",
    color: "var(--color-accent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "0.9rem",
    fontWeight: 800,
    flexShrink: 0,
  },
  tabs: {
    display: "flex",
    gap: "0.75rem",
    marginBottom: "1rem",
    borderBottom: "1px solid var(--color-border-light)",
    paddingBottom: "0.75rem",
  },
  tabButton: {
    flex: 1,
    fontSize: "0.9rem",
    justifyContent: "center",
  },
};
import React, { useEffect, useState, useRef } from "react";
import { Link, useParams, useLocation, useNavigate } from "react-router-dom";
import { api } from "../services/api";
import { useAuth } from "../context/AuthContext";
import ContributeModal from "../components/ContributeModal";
import RelativeTime from "../components/RelativeTime";
import DisputeModal from "../components/DisputeModal";
import TransactionHistory from "../components/TransactionHistory";
import MilestoneTracker from "../components/MilestoneTracker";
import WithdrawalsSection from "../components/WithdrawalsSection";
import CampaignDetailSkeleton from "../components/skeletons/CampaignDetailSkeleton";
import ContributionListSkeleton from "../components/skeletons/ContributionListSkeleton";
import VerificationBadge from "../components/VerificationBadge";
import CampaignStatusBadge from "../components/CampaignStatusBadge";
import { stellarExpertTxUrl } from "../config/stellar";
import CampaignQRCode from "../components/CampaignQRCode";
import { getNetwork, signTransaction } from '@stellar/freighter-api';
import { isConnected, getPublicKey } from "@stellar/freighter-api";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const BASE_URL = `${API_BASE_URL}/api`;

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function markdownToHtml(markdown) {
  const escaped = escapeHtml(markdown || '');
  return escaped
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(
      /\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    .replace(/\n/g, '<br />');
}

function progressColor(pct, status) {
  if (status === 'funded' || pct >= 100) return '#10b981'; // green — goal reached
  if (status === 'closed' || status === 'withdrawn' || status === 'refunded' || status === 'failed')
    return '#6b7280'; // grey — ended
  if (pct >= 75) return '#3b82f6'; // blue — nearly there
  return '#7c3aed'; // default purple
}

function ContributionRow({ c }) {
  const [copied, setCopied] = useState(false);
  const senderKey = c.sender_public_key || "";

  const handleCopy = () => {
    if (!senderKey) return;
    navigator.clipboard.writeText(senderKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={styles.row}>
      <div
        style={{
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
        }}
      >
        <div style={styles.avatar}>{(c.display_name || 'A')[0].toUpperCase()}</div>
        <div style={{ minWidth: 0 }}>
          <div style={styles.sender}>{c.display_name || 'Anonymous'}</div>
          <div style={styles.convHint}>
            {senderKey ? (
              <button
                type="button"
                onClick={handleCopy}
                title="Copy full public key"
                style={{
                  background: "none",
                  border: "none",
                  color: "inherit",
                  fontFamily: "monospace",
                  fontSize: "inherit",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {senderKey.slice(0, 4)}…{senderKey.slice(-4)}
              </button>
            ) : (
              <span>Anonymous</span>
            )}
            {" • "}
            <RelativeTime date={c.created_at} />
          </div>
          {c.refund_status && (
            <div style={styles.refundTag}>
              {c.refund_status === 'pending' && 'Refund pending'}
              {c.refund_status === 'submitted' && 'Refunded'}
              {c.refund_status === 'indexed' && 'Refunded'}
              {c.refund_status === 'failed' && 'Refund failed'}
              {c.refund_status === 'denied' && 'Refund denied'}
            </div>
          )}
          {c.tx_hash && (
            <a
              href={stellarExpertTxUrl(c.tx_hash)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: '0.75rem', color: '#7c3aed', fontWeight: 600 }}
            >
              View on chain ↗
            </a>
          )}
        </div>
      </div>
      {c.amount != null && (
        <span style={styles.amount}>
          {Number(c.amount).toLocaleString()} {c.asset}
        </span>
      )}
    </div>
  );
}

function isCampaignOwner(user, campaign) {
  const userId = user?.id ?? user?.userId;
  return (
    userId != null && campaign?.creator_id != null && String(userId) === String(campaign.creator_id)
  );
}

export default function Campaign() {
  const contributeBtnRef = useRef(null);
  const showAllRef = useRef(false);
  const editModalRef = useRef(null);
  const deleteModalRef = useRef(null);
  const editCloseHandlerRef = useRef(() => {});
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [campaign, setCampaign] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [contributions, setContributions] = useState(null);
  const contributionsRef = useRef([]);
  const [totalContributions, setTotalContributions] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [disputeSubmitted, setDisputeSubmitted] = useState(false);
  const [contributed, setContributed] = useState(false);

  const [freighterGuestMode, setFreighterGuestMode] = useState(false);
  const [showCreatedBanner, setShowCreatedBanner] = useState(!!location.state?.created);
  const [coverUploadError, setCoverUploadError] = useState(location.state?.coverUploadError || '');
  const [updates, setUpdates] = useState([]);
  const [milestones, setMilestones] = useState([]);
  const [updateForm, setUpdateForm] = useState({ title: '', body: '' });
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updatesError, setUpdatesError] = useState('');
  const [isLive, setIsLive] = useState(false);
  const [members, setMembers] = useState([]);
  const [isOwner, setIsOwner] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: '', role: 'viewer' });
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [isEditingCampaign, setIsEditingCampaign] = useState(false);
  const [editFormData, setEditFormData] = useState({
    title: '',
    description: '',
    deadline: '',
  });
  const [editError, setEditError] = useState('');
  const [editSuccess, setEditSuccess] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [editingUpdateId, setEditingUpdateId] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundError, setRefundError] = useState('');
  const [refundSuccess, setRefundSuccess] = useState('');
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [hasPendingWithdrawal, setHasPendingWithdrawal] = useState(false);

  useEffect(() => {
    document.body.dataset.printUrl = window.location.href;
    document.body.dataset.printDate = new Date().toLocaleDateString();
    return () => {
      delete document.body.dataset.printUrl;
      delete document.body.dataset.printDate;
    };
  }, []);

  useEffect(() => {
    if (!isEditingCampaign) return undefined;
    const prevActive = document.activeElement;
    const modal = editModalRef.current;
    if (!modal) return undefined;

    const getFocusable = () =>
      Array.from(
        modal.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.disabled);

    getFocusable()[0]?.focus();

    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        editCloseHandlerRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = getFocusable();
      if (items.length === 0) {
        e.preventDefault();
        modal.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !modal.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !modal.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    modal.addEventListener("keydown", onKey);
    return () => {
      modal.removeEventListener("keydown", onKey);
      prevActive?.focus?.();
    };
  }, [isEditingCampaign]);

  useEffect(() => {
    if (!showDeleteDialog) return undefined;
    const prevActive = document.activeElement;
    const modal = deleteModalRef.current;
    if (!modal) return undefined;

    const getFocusable = () =>
      Array.from(
        modal.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.disabled);

    getFocusable()[0]?.focus();

    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeDeleteDialog();
        return;
      }
      if (e.key !== "Tab") return;
      const items = getFocusable();
      if (items.length === 0) {
        e.preventDefault();
        modal.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !modal.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !modal.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    modal.addEventListener("keydown", onKey);
    return () => {
      modal.removeEventListener("keydown", onKey);
      prevActive?.focus?.();
    };
  }, [showDeleteDialog]);

  useEffect(() => {
    setLoadError("");
    api
      .getCampaign(id)
      .then((data) => {
        setCampaign(data);
        if (data.user_role === 'owner') {
          setIsOwner(true);
          api
            .getCampaignMembers(id)
            .then(setMembers)
            .catch(() => {});
        } else {
          setIsOwner(false);
        }
      })
      .catch((err) => setLoadError(err.message || 'Could not load campaign.'));
    api
      .getContributions(id, { limit: showAll ? 100 : 10, offset: 0 })
      .then((data) => {
        const nextContributions = data.contributions || [];
        contributionsRef.current = nextContributions;
        setContributions(nextContributions);
        setTotalContributions(data.total || 0);
      })
      .catch(() => {
        contributionsRef.current = [];
        setContributions([]);
        setTotalContributions(0);
      });
    api
      .getMilestones(id)
      .then(setMilestones)
      .catch(() => setMilestones([]));
    api
      .getCampaignUpdates(id, { limit: 20 })
      .then(setUpdates)
      .catch(() => setUpdates([]));
    if (user) {
      api
        .getCampaignAnalytics(id)
        .then(setAnalytics)
        .catch(() => setAnalytics(null));
    }

    // Check for pending withdrawals
    if (user) {
      api
        .listWithdrawals(id)
        .then((withdrawals) => {
          const hasPending = withdrawals.some((w) => w.status === 'pending');
          setHasPendingWithdrawal(hasPending);
        })
        .catch(() => setHasPendingWithdrawal(false));
    }
  }, [id, user, contributed, showAll]);

  useEffect(() => {
    if (!id) return;
    if (isLive) return;
    if (!campaign) return;

    const isCampaignClosed = [
      'funded',
      'closed',
      'withdrawn',
      'failed',
      'completed',
      'refunded',
    ].includes(campaign.status);
    if (isCampaignClosed) return;

    let intervalId = null;
    let aborted = false;

    const refresh = async () => {
      if (aborted) return;
      if (document.visibilityState !== 'visible') return;
      try {
        const [nextCampaign, nextContributionsData] = await Promise.all([
          api.getCampaign(id),
          api.getContributions(id, { limit: showAll ? 100 : 10, offset: 0 }),
        ]);
        if (aborted) return;
        setCampaign(nextCampaign);
        const nextContributions = nextContributionsData.contributions || [];
        contributionsRef.current = nextContributions;
        setContributions(nextContributions);
        setTotalContributions(nextContributionsData.total || 0);
      } catch {
        // ignore transient polling errors
      }
    };

    const start = () => {
      if (intervalId != null) return;
      refresh();
      intervalId = window.setInterval(refresh, 15_000);
    };

    const stop = () => {
      if (intervalId == null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();

    return () => {
      aborted = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [id, isLive, campaign?.status, showAll]);

  useEffect(() => {
    showAllRef.current = showAll;
  }, [showAll]);

  useEffect(() => {
    if (!id) return;
    if (!window.EventSource) return;

    let es = null;
    let reconnectTimer = null;
    let retryDelay = 1000;
    const maxRetryDelay = 30000;
    let isMounted = true;

    function connect() {
      if (!isMounted) return;
      if (es) {
        try {
          es.close();
        } catch {}
        es = null;
      }

      try {
        es = new EventSource(`${BASE_URL}/campaigns/${id}/stream`);
      } catch {
        scheduleReconnect();
        return;
      }

      es.onopen = () => {
        if (!isMounted) return;
        setIsLive(true);
        retryDelay = 1000;
      };

      es.onmessage = (e) => {
        if (!isMounted) return;
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (msg.type === "contribution") {
          setCampaign((prev) =>
            prev ? { ...prev, raised_amount: msg.raised_amount } : prev,
          );
          const current = contributionsRef.current;
          if (current.some((c) => c.tx_hash === msg.contribution.tx_hash)) return;

          const updated = [msg.contribution, ...current];
          contributionsRef.current = !showAllRef.current && updated.length > 10
            ? updated.slice(0, 10)
            : updated;
          setContributions(contributionsRef.current);
          setTotalContributions((total) => total + 1);
        }
      };

      es.onerror = () => {
        if (!isMounted) return;
        setIsLive(false);
        if (es) {
          try {
            es.close();
          } catch {}
          es = null;
        }
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (!isMounted) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
    }

    connect();

    return () => {
      isMounted = false;
      clearTimeout(reconnectTimer);
      if (es) {
        try {
          es.close();
        } catch {}
        es = null;
      }
      setIsLive(false);
    };
  }, [id]);

  useEffect(() => {
    if (location.state?.created) {
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  async function handleClone() {
    try {
      const data = await api.getCloneData(id);
      navigate('/campaigns/new', { state: { prefill: data } });
    } catch (err) {
      alert(err.message || 'Failed to fetch campaign clone data');
    }
  }

  async function handleInviteSubmit(e) {
    e.preventDefault();
    if (!inviteForm.email) {
      setInviteError('Email is required');
      return;
    }
    setInviteBusy(true);
    setInviteError('');
    setInviteSuccess(false);
    try {
      const newMember = await api.inviteCampaignMember(id, inviteForm);
      setMembers((prev) => [...prev, newMember]);
      setInviteForm({ email: '', role: 'viewer' });
      setInviteSuccess(true);
    } catch (err) {
      setInviteError(err.message || 'Failed to invite member');
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRoleChange(userId, newRole) {
    try {
      const updated = await api.updateCampaignMemberRole(id, userId, { role: newRole });
      setMembers((prev) =>
        prev.map((m) => (m.user_id === userId ? { ...m, role: updated.role } : m))
      );
    } catch (err) {
      alert(err.message || 'Failed to update role');
    }
  }

  async function handleRemoveMember(userId) {
    if (!confirm('Are you sure you want to remove this member?')) return;
    try {
      await api.removeCampaignMember(id, userId);
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    } catch (err) {
      alert(err.message || 'Failed to remove member');
    }
  }

  function handleOpenEditModal() {
    if (!campaign) return;
    setEditFormData({
      title: campaign.title || '',
      description: campaign.description || '',
      deadline: campaign.deadline ? campaign.deadline.split('T')[0] : '',
    });
    setEditError('');
    setEditSuccess('');
    setIsEditingCampaign(true);
  }

  function handleCloseEditModal() {
    setIsEditingCampaign(false);
    setEditFormData({ title: '', description: '', deadline: '' });
    setEditError('');
    setEditSuccess('');
  }

  function editFormIsDirty() {
    if (!campaign) return false;
    return (
      editFormData.title !== (campaign.title || "") ||
      editFormData.description !== (campaign.description || "") ||
      editFormData.deadline !==
        (campaign.deadline ? campaign.deadline.split("T")[0] : "")
    );
  }

  function handleRequestCloseEditModal() {
    if (editLoading) return;
    if (
      editFormIsDirty() &&
      !window.confirm("You have unsaved changes. Discard them?")
    ) {
      return;
    }
    handleCloseEditModal();
  }

  editCloseHandlerRef.current = handleRequestCloseEditModal;

  function closeDeleteDialog() {
    setShowDeleteDialog(false);
    setDeleteConfirmation("");
    setDeleteError("");
  }

  async function handleSaveEdit() {
    setEditError('');

    // Validate form
    if (!editFormData.title.trim()) {
      setEditError('Title is required');
      return;
    }
    if (editFormData.title.length > 100) {
      setEditError('Title must be at most 100 characters');
      return;
    }
    if (editFormData.description.length > 1000) {
      setEditError('Description must be at most 1000 characters');
      return;
    }
    if (editFormData.deadline) {
      const deadlineDate = new Date(editFormData.deadline);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      deadlineDate.setHours(0, 0, 0, 0);
      if (deadlineDate < today) {
        setEditError('Deadline cannot be in the past');
        return;
      }
    }

    try {
      setEditLoading(true);
      const updates = {};
      if (editFormData.title !== campaign.title) updates.title = editFormData.title;
      if (editFormData.description !== campaign.description)
        updates.description = editFormData.description;
      if (editFormData.deadline !== (campaign.deadline ? campaign.deadline.split('T')[0] : '')) {
        updates.deadline = editFormData.deadline || null;
      }

      if (Object.keys(updates).length === 0) {
        setEditError('No changes to save');
        setEditLoading(false);
        return;
      }

      const updated = await api.updateCampaign(campaign.id, updates);
      setCampaign(updated);
      setIsEditingCampaign(false);
      setEditFormData({ title: '', description: '', deadline: '' });
      setEditSuccess('Campaign updated successfully!');
      setTimeout(() => setEditSuccess(''), 3000);
    } catch (err) {
      setEditError(err.message || 'Failed to update campaign');
    } finally {
      setEditLoading(false);
    }
  }

  async function handleInitiateRefund() {
    setRefundBusy(true);
    setRefundError('');
    setRefundSuccess('');
    try {
      const initRes = await api.initiateRefund(campaign.id);
      const unsignedXdr = initRes.unsigned_xdr;

      let signedXdr = unsignedXdr;
      if (user?.wallet_type === 'freighter') {
        const network = await getNetwork();
        if (network?.error) throw new Error('Could not read Freighter network');

        const signed = await signTransaction(unsignedXdr, {
          networkPassphrase: network?.networkPassphrase,
          address: user?.wallet_public_key,
        });
        if (signed?.error) throw new Error(signed.error?.message || 'Freighter signing failed');
        if (!signed?.signedTxXdr) throw new Error('Freighter did not return a signed transaction');

        const approveRes = await api.approveRefundCreator(campaign.id, {
          signed_xdr: signed.signedTxXdr,
        });
        signedXdr = approveRes.signed_xdr;
      } else {
        const approveRes = await api.approveRefundCreator(campaign.id, {});
        signedXdr = approveRes.signed_xdr;
      }

      let isPlatformApprover = false;
      try {
        const capRes = await api.getWithdrawalCapabilities();
        if (capRes.can_approve_platform) {
          isPlatformApprover = true;
        }
      } catch (err) {
        // ignore
      }

      if (isPlatformApprover) {
        await api.approveRefundPlatform(campaign.id);
        setRefundSuccess('Campaign contributions successfully refunded!');
      } else {
        setRefundSuccess('Refund signed by creator. Awaiting platform release.');
      }

      const updatedCampaign = await api.getCampaign(campaign.id);
      setCampaign(updatedCampaign);
    } catch (err) {
      setRefundError(err.message || 'Failed to initiate refund.');
    } finally {
      setRefundBusy(false);
    }
  }
  async function handleDeleteCampaign() {
    setDeleteError('');
    if (!campaign) return;

    // Check if confirmation matches campaign title
    if (deleteConfirmation !== campaign.title) {
      setDeleteError('Confirmation does not match campaign title');
      return;
    }

    try {
      setDeleteLoading(true);
      await api.deleteCampaign(campaign.id);
      setShowDeleteDialog(false);
      setDeleteConfirmation('');
      // Redirect to home after successful deletion
      window.location.href = '/';
    } catch (err) {
      setDeleteError(err.message || 'Failed to delete campaign');
    } finally {
      setDeleteLoading(false);
    }
  }

  useEffect(() => {
    if (!campaign) return;
    document.title = `${campaign.title} | CrowdPay`;

    // Basic meta tag updates (SPA approach)
    const updateMeta = (name, content, property = false) => {
      let el = document.querySelector(
        property ? `meta[property="${name}"]` : `meta[name="${name}"]`
      );
      if (!el) {
        el = document.createElement('meta');
        if (property) el.setAttribute('property', name);
        else el.setAttribute('name', name);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };

    updateMeta('description', campaign.description || '');
    updateMeta('og:title', campaign.title, true);
    updateMeta('og:description', campaign.description || '', true);
    updateMeta('og:url', window.location.href, true);
    if (campaign.cover_image_url) {
      updateMeta('og:image', campaign.cover_image_url, true);
      updateMeta('twitter:image', campaign.cover_image_url);
    }
    updateMeta('twitter:card', 'summary_large_image');
    updateMeta('twitter:title', campaign.title);
    updateMeta('twitter:description', campaign.description || '');
  }, [campaign]);

  if (loadError && !campaign) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '2.5rem' }}>
        <p className="alert alert--error" role="alert">
          {loadError}
        </p>
        <Link to="/" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          ← Back home
        </Link>
      </main>
    );
  }

  if (!campaign) {
    return <CampaignDetailSkeleton />;
  }

  const pct = Math.min(100, (campaign.raised_amount / campaign.target_amount) * 100).toFixed(1);
  const canPostUpdate = isCampaignOwner(user, campaign);
  const campaignUrl = `${window.location.origin}/campaigns/${id}`;
  const embedCode = `<iframe src="${window.location.origin}/embed/campaigns/${id}" width="480" height="280" frameborder="0" title="CrowdPay campaign"></iframe>`;

  function canEditUpdate(update) {
    return Date.now() - new Date(update.created_at).getTime() <= 24 * 60 * 60 * 1000;
  }

  function startEditUpdate(update) {
    setEditingUpdateId(update.id);
    setUpdateForm({ title: update.title, body: update.body });
    setUpdatesError('');
  }

  function cancelUpdateEdit() {
    setEditingUpdateId(null);
    setUpdateForm({ title: '', body: '' });
    setUpdatesError('');
  }

  async function handleFreighterContribute() {
    try {
      const connected = await isConnected()
        .then((r) => r?.isConnected ?? r)
        .catch(() => false);
      if (!connected) {
        window.open('https://www.freighter.app/', '_blank', 'noopener,noreferrer');
        return;
      }
      setFreighterGuestMode(true);
      setShowModal(true);
    } catch {
      window.open('https://www.freighter.app/', '_blank', 'noopener,noreferrer');
    }
  }

  async function submitUpdate(e) {
    e.preventDefault();
    setUpdatesError('');
    setUpdateBusy(true);

    try {
      if (editingUpdateId) {
        const updated = await api.updateCampaignUpdate(campaign.id, editingUpdateId, {
          title: updateForm.title.trim(),
          body: updateForm.body.trim(),
        });

        setUpdates((prev) => prev.map((item) => (item.id === editingUpdateId ? updated : item)));
        setEditingUpdateId(null);
      } else {
        const created = await api.postCampaignUpdate(campaign.id, {
          title: updateForm.title.trim(),
          body: updateForm.body.trim(),
        });

        setUpdates((prev) => [created, ...prev]);
      }

      setUpdateForm({ title: '', body: '' });
    } catch (err) {
      setUpdatesError(err.message || 'Could not save update');
    } finally {
      setUpdateBusy(false);
    }
  }

  async function deleteUpdate(updateId) {
    if (!confirm('Delete this campaign update?')) return;

    setUpdatesError('');
    try {
      await api.deleteCampaignUpdate(campaign.id, updateId);
      setUpdates((prev) => prev.filter((item) => item.id !== updateId));
    } catch (err) {
      setUpdatesError(err.message || 'Could not delete update');
    }
  }
  return (
    <main
      className="container"
      style={{ paddingTop: '2.5rem', paddingBottom: '4rem', maxWidth: '760px' }}
    >
      {showCreatedBanner && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Campaign is live.</strong> Share the link — contributors can fund in XLM or USDC
          when conversion paths are available.
          <button
            type="button"
            onClick={() => setShowCreatedBanner(false)}
            style={{
              marginLeft: '0.5rem',
              background: 'transparent',
              color: 'var(--color-success-text)',
              textDecoration: 'underline',
              fontWeight: 600,
              padding: 0,
              minHeight: 'auto',
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {coverUploadError && (
        <div className="alert alert--warning" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Cover image upload failed:</strong> {coverUploadError}
        </div>
      )}
      {campaign.status === 'funded' && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Goal reached.</strong> This campaign has met its funding target. Contributions may
          still be open until the creator closes the campaign.
        </div>
      )}
      {campaign.status === 'failed' && (
        <div className="alert alert--error" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Campaign ended.</strong> This campaign did not reach its goal. Contributions are
          closed and refunds can be requested.
        </div>
      )}
      {campaign.status === 'refunded' && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Campaign refunded.</strong> This campaign was refunded — all contributions have
          been returned to their original senders.
        </div>
      )}
      {campaign.status === 'failed' && user && isCampaignOwner(user, campaign) && (
        <div
          style={{
            background: 'var(--color-bg-card, #1e1e2f)',
            border: '1px solid var(--color-border-light)',
            borderRadius: '10px',
            padding: '1.1rem 1.25rem',
            marginBottom: '1.25rem',
          }}
        >
          <p
            style={{
              margin: '0 0 0.75rem',
              fontSize: '0.9rem',
              color: 'var(--color-text-secondary)',
              lineHeight: 1.55,
            }}
          >
            This campaign did not reach its goal. You can refund all contributors — this will build
            and sign a Stellar transaction that returns each contributor's exact amount.
          </p>
          {refundError && (
            <p
              className="alert alert--error"
              style={{ marginBottom: '0.75rem', fontSize: '0.875rem' }}
              role="alert"
            >
              {refundError}
            </p>
          )}
          {refundSuccess && (
            <p
              className="alert alert--success"
              style={{ marginBottom: '0.75rem', fontSize: '0.875rem' }}
              role="status"
            >
              {refundSuccess}
            </p>
          )}
          <button
            id="btn-refund-contributors"
            type="button"
            className="btn-primary"
            disabled={refundBusy}
            onClick={handleInitiateRefund}
            style={{
              background: refundBusy ? undefined : '#dc2626',
              borderColor: refundBusy ? undefined : '#dc2626',
              fontSize: '0.9rem',
            }}
          >
            {refundBusy ? 'Processing refund…' : 'Refund contributors'}
          </button>
        </div>
      )}
      {campaign.creator_kyc_status !== 'verified' && (
        <div className="alert alert--warning" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Legacy campaign:</strong> this campaign was created before creator identity
          verification was required.
        </div>
      )}
      {editSuccess && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          {editSuccess}
        </div>
      )}
      {campaign.cover_image_url && (
        <img src={campaign.cover_image_url} alt={campaign.title} style={styles.detailCoverImage} />
      )}
      {!campaign.cover_image_url && (
        <div style={styles.detailCoverPlaceholder} aria-hidden="true">
          <span style={styles.detailCoverPlaceholderText}>No campaign image yet</span>
        </div>
      )}
      <div style={styles.header}>
        <div style={styles.badgeRow}>
          <span style={styles.asset}>{campaign.asset_type}</span>
          <CampaignStatusBadge status={campaign.status} />
          <VerificationBadge status={campaign.creator_kyc_status} />
        </div>
        <h1 style={styles.title}>{campaign.title}</h1>
        {campaign.creator_name && <p style={styles.creator}>by {campaign.creator_name}</p>}
        <p style={styles.desc}>{campaign.description}</p>
      </div>

      <div style={styles.card}>
        <div style={styles.amounts}>
          <div>
            <div style={styles.big}>
              {Number(campaign.raised_amount).toLocaleString()} {campaign.asset_type}
            </div>
            <div style={styles.small}>
              raised of {Number(campaign.target_amount).toLocaleString()} goal
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={styles.big}>{pct}%</div>
            <div style={styles.small}>
              funded by <strong>{campaign.contributor_count || 0}</strong> backers
            </div>
          </div>
        </div>
        <div
          role="progressbar"
          className="campaign-progress-bar"
          aria-valuenow={Number(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pct}% of goal raised`}
          style={styles.bar}
        >
          <div
            style={{
              ...styles.fill,
              background: progressColor(parseFloat(pct), campaign.status),
              width: `${pct}%`,
            }}
            aria-hidden="true"
          />
        </div>

        {campaign.status === 'refunded' ? (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
            This campaign has been <strong>refunded</strong>. All contributions were returned to
            their original senders.
          </p>
        ) : ['failed', 'closed', 'withdrawn'].includes(campaign.status) ? (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
            Contributions are closed while this campaign is <strong>{campaign.status}</strong>.
          </p>
        ) : user ? (
          <button
            type="button"
            className="btn-primary"
            style={styles.cta}
            ref={contributeBtnRef}
            aria-label={`Contribute to ${campaign.title}`}
            onClick={() => setShowModal(true)}
          >
            Contribute
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            <Link
              to="/login"
              state={{ from: `/campaigns/${id}` }}
              className="btn-primary"
              style={{
                ...styles.cta,
                textAlign: 'center',
                textDecoration: 'none',
                display: 'block',
              }}
            >
              Log in to contribute
            </Link>
            <button
              type="button"
              className="btn-secondary"
              style={styles.cta}
              onClick={handleFreighterContribute}
            >
              Contribute with Freighter
            </button>
          </div>
        )}

        {user && (
          <button
            type="button"
            className="btn-secondary"
            style={{ ...styles.cta, marginTop: '0.75rem' }}
            onClick={handleClone}
          >
            Clone campaign
          </button>
        )}
      </div>

      <div
        data-no-print
        style={{
          display: 'flex',
          gap: '0.65rem',
          marginBottom: '1.75rem',
          flexWrap: 'wrap',
        }}
      >
        {navigator.share && (
          <button
            type="button"
            className="btn-secondary"
            style={{
              flex: 1,
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
            }}
            onClick={async () => {
              try {
                await navigator.share({
                  title: campaign.title,
                  text: campaign.description,
                  url: window.location.href,
                });
              } catch (err) {
                // User cancelled share or error occurred
                if (err.name !== 'AbortError') {
                  console.error('Share failed:', err);
                }
              }
            }}
          >
            Share
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          style={{
            flex: 1,
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
          }}
          onClick={() => {
            const text = encodeURIComponent(
              `I just backed ${campaign.title} on CrowdPay — ${pct}% funded with ${campaign.contributor_count || 0} backers. Join me: ${window.location.href}`,
            );
            window.open(
              `https://twitter.com/intent/tweet?text=${text}`,
              "_blank",
              "noopener,noreferrer",
            );
            window.open(`https://twitter.com/intent/tweet?text=${text}`, '_blank');
          }}
        >
          Share on X
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{
            flex: 1,
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
          }}
          onClick={() => {
            const text = encodeURIComponent(
              `I just backed ${campaign.title} on CrowdPay — ${pct}% funded with ${campaign.contributor_count || 0} backers. Join me: ${window.location.href}`
            );
            window.open(`https://wa.me/?text=${text}`, "_blank", "noopener,noreferrer");
          }}
        >
          WhatsApp
        </button>
        <div style={{ position: 'relative', flex: 1 }}>
          <button
            type="button"
            className="btn-secondary"
            style={{
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              width: '100%',
              background: linkCopied ? 'var(--color-success-text)' : undefined,
              borderColor: linkCopied ? 'var(--color-success-text)' : undefined,
              color: linkCopied ? '#fff' : undefined,
              transition: 'all 0.2s ease',
            }}
            onClick={() => {
              navigator.clipboard.writeText(window.location.href);
              setLinkCopied(true);
              setTimeout(() => setLinkCopied(false), 2000);
            }}
          >
            {linkCopied ? 'Copied!' : 'Copy link'}
          </button>
        </div>
      </div>

      {/* Edit campaign button - visible only to creator */}
      {isCampaignOwner(user, campaign) && ['active', 'funded'].includes(campaign.status) && (
        <div
          data-no-print
          style={{
            display: 'flex',
            gap: '0.65rem',
            marginBottom: '1.75rem',
          }}
        >
          <button
            type="button"
            className="btn-secondary"
            style={{
              flex: 1,
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
            }}
            onClick={handleOpenEditModal}
          >
            Edit Campaign
          </button>
          {campaign.status === 'active' && !hasPendingWithdrawal && (
            <button
              type="button"
              className="btn-secondary"
              style={{
                color: '#dc2626',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
              }}
              onClick={() => setShowDeleteDialog(true)}
            >
              Delete campaign
            </button>
          )}
        </div>
      )}

      <div style={styles.walletInfo}>
        <span style={styles.walletLabel}>Campaign wallet</span>
        <code style={styles.walletKey}>{campaign.wallet_public_key}</code>
      </div>

      <div style={{ marginBottom: '1.75rem' }}>
        <button
          type="button"
          className="btn-secondary"
          data-no-print
          onClick={() => setShowQR((v) => !v)}
        >
          {showQR ? 'Hide QR code' : 'Show QR code'}
        </button>
        <div
          className="qr-wrapper"
          style={{ marginTop: '1rem', display: showQR ? 'flex' : 'none', justifyContent: 'center' }}
        >
          <CampaignQRCode url={campaignUrl} size={200} />
        </div>
      </div>

      <details style={{ ...styles.card, marginTop: '-0.75rem' }}>
        <summary style={styles.embedSummary}>Embed on your site</summary>
        <pre style={{ ...styles.embedCode, marginTop: '0.75rem' }}>{embedCode}</pre>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(embedCode).then(() => {
              setEmbedCopied(true);
              setTimeout(() => setEmbedCopied(false), 2000);
            });
          }}
          className="btn-secondary"
          style={{ marginTop: '0.75rem', fontSize: '0.85rem', minHeight: 'auto' }}
        >
          {embedCopied ? 'Copied!' : 'Copy snippet'}
        </button>
      </details>

      {/* Report a problem — visible to contributors who have backed this campaign */}
      {user &&
        contributions?.some((c) => c.sender_public_key) &&
        !isCampaignOwner(user, campaign) && (
          <div style={{ marginBottom: '1.25rem' }} data-no-print>
            {disputeSubmitted ? (
              <p className="alert alert--success" role="status">
                Your dispute has been submitted. The platform team will review it shortly.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setShowDisputeModal(true)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-status-error)',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                  padding: 0,
                  textDecoration: 'underline',
                }}
              >
                ⚠ Report a problem with this campaign
              </button>
            )}
          </div>
        )}

      {user && (
        <div id="withdrawals" data-no-print>
          <WithdrawalsSection
            campaign={campaign}
            milestones={milestones}
            user={user}
            onReleased={() => {
              api
                .getCampaign(id)
                .then(setCampaign)
                .catch(() => {});
              api
                .getMilestones(id)
                .then(setMilestones)
                .catch(() => {});
            }}
          />
        </div>
      )}

      <TransactionHistory campaignId={campaign.id} isCreator={isCampaignOwner(user, campaign)} />

      <MilestoneTracker milestones={milestones} assetType={campaign.asset_type} />
      {isOwner && (
        <div style={{ marginBottom: '2rem' }} data-no-print>
          <h2 style={styles.sectionTitle}>Team Management</h2>
          <div className="campaign-card" style={{ marginBottom: '1.5rem' }}>
            <strong style={{ marginBottom: '0.75rem', display: 'block' }}>
              Invite Team Member
            </strong>
            <form
              onSubmit={handleInviteSubmit}
              style={{
                display: 'flex',
                gap: '0.75rem',
                flexWrap: 'wrap',
                alignItems: 'flex-end',
              }}
            >
              <div style={{ flex: '1 1 250px' }}>
                <label
                  style={{
                    fontSize: '0.85rem',
                    color: 'var(--color-text-hint)',
                    display: 'block',
                    marginBottom: '0.25rem',
                  }}
                >
                  Email
                </label>
                <input
                  type="email"
                  placeholder="member@example.com"
                  value={inviteForm.email}
                  onChange={(e) => setInviteForm((s) => ({ ...s, email: e.target.value }))}
                  required
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ width: '120px' }}>
                <label
                  style={{
                    fontSize: '0.85rem',
                    color: 'var(--color-text-hint)',
                    display: 'block',
                    marginBottom: '0.25rem',
                  }}
                >
                  Role
                </label>
                <select
                  value={inviteForm.role}
                  onChange={(e) => setInviteForm((s) => ({ ...s, role: e.target.value }))}
                  style={{ width: '100%', padding: '0.5rem' }}
                >
                  <option value="viewer">Viewer</option>
                  <option value="manager">Manager</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
              <button
                type="submit"
                className="btn-primary"
                disabled={inviteBusy}
                style={{ height: '38px' }}
              >
                {inviteBusy ? 'Sending…' : 'Invite'}
              </button>
            </form>
            {inviteError && (
              <p className="alert alert--error" style={{ marginTop: '0.75rem' }}>
                {inviteError}
              </p>
            )}
            {inviteSuccess && (
              <p className="alert alert--success" style={{ marginTop: '0.75rem' }}>
                Invitation sent!
              </p>
            )}
          </div>

          <div className="campaign-card">
            <strong style={{ marginBottom: '0.75rem', display: 'block' }}>Current Team</strong>
            {members.length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)' }}>No team members yet.</p>
            ) : (
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                {members.map((member) => (
                  <div
                    key={member.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '1rem',
                      borderBottom: '1px solid var(--color-border-lighter)',
                      paddingBottom: '0.5rem',
                    }}
                  >
                    <div>
                      <span style={{ fontWeight: 600 }}>{member.email}</span>
                      {member.user_name && (
                        <span
                          style={{
                            color: 'var(--color-text-hint)',
                            fontSize: '0.85rem',
                            marginLeft: '0.5rem',
                          }}
                        >
                          ({member.user_name})
                        </span>
                      )}
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: member.accepted_at
                            ? 'var(--color-success-text)'
                            : 'var(--color-warning-text)',
                          fontWeight: 600,
                        }}
                      >
                        {member.accepted_at ? 'Accepted' : 'Pending'}
                      </div>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: '0.5rem',
                        alignItems: 'center',
                      }}
                    >
                      <select
                        value={member.role}
                        onChange={(e) => handleRoleChange(member.user_id, e.target.value)}
                        disabled={!member.user_id || String(member.user_id) === String(user?.id)}
                        style={{ padding: '0.25rem', fontSize: '0.85rem' }}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="manager">Manager</option>
                        <option value="owner">Owner</option>
                      </select>
                      <button
                        className="btn-secondary"
                        onClick={() => handleRemoveMember(member.user_id)}
                        disabled={String(member.user_id) === String(user?.id)}
                        style={{
                          padding: '0.25rem 0.5rem',
                          fontSize: '0.85rem',
                          color: 'var(--color-status-error)',
                          borderColor: 'var(--color-status-error)',
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <h2 style={styles.sectionTitle}>Updates ({updates.length})</h2>
      {canPostUpdate && (
        <form
          onSubmit={submitUpdate}
          className="campaign-card"
          style={{ marginBottom: '1rem' }}
          data-no-print
        >
          <strong style={{ marginBottom: '0.5rem', display: 'block' }}>
            {editingUpdateId ? 'Edit update' : 'Post update'}
          </strong>
          <input
            placeholder="Update title"
            value={updateForm.title}
            onChange={(e) => setUpdateForm((s) => ({ ...s, title: e.target.value }))}
            required
            style={{ marginBottom: '0.5rem' }}
          />
          <textarea
            placeholder="Write markdown update..."
            value={updateForm.body}
            onChange={(e) => setUpdateForm((s) => ({ ...s, body: e.target.value }))}
            rows={4}
            required
          />
          {updatesError && (
            <div
              style={{
                color: 'var(--color-status-error)',
                fontSize: '0.85rem',
                marginTop: '0.5rem',
              }}
            >
              {updatesError}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="submit" className="btn-primary" disabled={updateBusy}>
              {updateBusy ? 'Saving...' : editingUpdateId ? 'Save update' : 'Post update'}
            </button>
            {editingUpdateId && (
              <button type="button" className="btn-secondary" onClick={cancelUpdateEdit}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {updates.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)', marginBottom: '1rem' }}>
          No updates yet — the creator hasn't posted anything.
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gap: '0.75rem',
            marginBottom: '1.25rem',
          }}
        >
          {updates.map((update) => (
            <article key={update.id} className="campaign-card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                }}
              >
                <strong>{update.title}</strong>
                <span
                  style={{
                    color: 'var(--color-text-hint)',
                    fontSize: '0.85rem',
                  }}
                >
                  {update.author_name} • <RelativeTime date={update.created_at} />
                </span>
              </div>

              <div
                style={{
                  marginTop: '0.5rem',
                  color: 'var(--color-text-primary)',
                  lineHeight: 1.5,
                }}
                dangerouslySetInnerHTML={{
                  __html: markdownToHtml(update.body),
                }}
              />

              {canPostUpdate && (
                <div
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    marginTop: '0.75rem',
                  }}
                >
                  {canEditUpdate(update) && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => startEditUpdate(update)}
                      style={{
                        fontSize: '0.85rem',
                        padding: '0.4rem 0.75rem',
                      }}
                    >
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => deleteUpdate(update.id)}
                    style={{
                      fontSize: '0.85rem',
                      padding: '0.4rem 0.75rem',
                      color: 'var(--color-status-error)',
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {/* Analytics Section */}
      {isOwner && analytics && (
        <div style={{ marginBottom: '2rem' }}>
          <h2 style={styles.sectionTitle}>Analytics</h2>
          {!analytics.dailyTotals || analytics.dailyTotals.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)' }}>No analytics data available yet.</p>
          ) : (
            <div style={{ display: 'grid', gap: '1.5rem' }}>
              <div className="campaign-card">
                <strong style={{ display: 'block', marginBottom: '1rem' }}>
                  Contributions (Last 30 Days)
                </strong>
                <svg width="100%" height={150} viewBox={`0 0 600 150`} preserveAspectRatio="none">
                  {analytics.dailyTotals.map((day, i) => {
                    const maxAmount = Math.max(
                      ...analytics.dailyTotals.map((d) => Number(d.total_amount) || 0),
                      1
                    );
                    const barWidth = 600 / Math.max(analytics.dailyTotals.length, 1);
                    const barHeight = Math.max(5, (Number(day.total_amount) / maxAmount) * 150);
                    const y = 150 - barHeight;
                    const x = i * barWidth;
                    return (
                      <g key={i}>
                        <title>{`${new Date(day.day).toLocaleDateString()}: ${day.total_amount} ${day.asset}`}</title>
                        <rect
                          x={x}
                          y={y}
                          width={Math.max(barWidth - 2, 2)}
                          height={barHeight}
                          fill="var(--color-accent)"
                          rx="2"
                        />
                      </g>
                    );
                  })}
                </svg>
              </div>

              <div className="campaign-card">
                <strong style={{ display: "block", marginBottom: "1rem" }}>
                  Asset Breakdown
                </strong>
                {(analytics.assetBreakdown || []).map((asset) => (
                  <div
                    key={asset.paid_with}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <span>{asset.paid_with}</span>
                    <strong>{asset.total_sent}</strong>
                  </div>
                ))}
              </div>

              <div className="campaign-card">
                <strong style={{ display: "block", marginBottom: "1rem" }}>
                  Top Contributors
                </strong>
                {(analytics.topContributors || []).map((c, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '0.5rem',
                      fontFamily: 'monospace',
                    }}
                  >
                    <span>
                      {c.sender_public_key
                        ? `${c.sender_public_key.slice(0, 4)}...${c.sender_public_key.slice(-4)}`
                        : "Anonymous"}
                    </span>
                    <span>
                      {c.total} ({c.times} contributions)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <h2 style={styles.sectionTitle}>
        Backer Wall {contributions !== null ? `(${totalContributions})` : ''}
        {isLive && (
          <span style={styles.liveIndicator} title="Live updates active">
            <span style={styles.liveDot} />
            Live
          </span>
        )}
      </h2>
      {contributions === null ? (
        <ContributionListSkeleton />
      ) : contributions.length === 0 ? (
        <div style={styles.emptyBackers}>
          <p>Be the first to back this!</p>
          <p
            style={{
              fontSize: '0.9rem',
              color: 'var(--color-text-secondary)',
              marginTop: '0.25rem',
            }}
          >
            Every contribution counts towards making this goal a reality.
          </p>
        </div>
      ) : (
        <>
          <div style={styles.list} className="contributions-list">
            {contributions.map((c) => (
              <ContributionRow key={c.id} c={c} />
            ))}
          </div>
          {totalContributions > 10 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                marginTop: '1rem',
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowAll((prev) => !prev)}
                style={{
                  padding: '0.5rem 1.5rem',
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                }}
              >
                {showAll ? 'Show less' : `Show all (${totalContributions})`}
              </button>
            </div>
          )}
        </>
      )}

      {showModal && (
        <ContributeModal
          campaign={campaign}
          guestFreighterMode={freighterGuestMode}
          onClose={() => {
            setShowModal(false);
            setFreighterGuestMode(false);
            contributeBtnRef.current?.focus();
          }}
          onSuccess={() => setContributed((v) => !v)}
        />
      )}
      {showDisputeModal && (
        <DisputeModal
          campaign={campaign}
          onClose={() => setShowDisputeModal(false)}
          onSubmitted={() => setDisputeSubmitted(true)}
        />
      )}

      {/* Edit Campaign Modal */}
      {isEditingCampaign && campaign && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={handleRequestCloseEditModal}
        >
          <div
            ref={editModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-campaign-modal-title"
            tabIndex={-1}
            style={{
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border-light)',
              borderRadius: '12px',
              padding: '2rem',
              maxWidth: '500px',
              width: '90%',
              maxHeight: '90vh',
              overflowY: 'auto',
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="edit-campaign-modal-title"
              style={{
                marginTop: 0,
                marginBottom: '1.5rem',
                fontSize: '1.5rem',
                color: 'var(--color-text-primary)',
              }}
            >
              Edit Campaign
            </h2>

            {editError && (
              <p
                role="alert"
                style={{
                  color: 'var(--color-danger-text, #ef4444)',
                  marginBottom: '1rem',
                  padding: '0.75rem',
                  background: 'var(--color-danger-bg, #fee2e2)',
                  borderRadius: '6px',
                }}
              >
                {editError}
              </p>
            )}

            <div style={{ marginBottom: '1.5rem' }}>
              <label
                htmlFor="edit-campaign-title"
                style={{
                  display: 'block',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                  color: 'var(--color-text-primary)',
                }}
              >
                Title
              </label>
              <input
                id="edit-campaign-title"
                type="text"
                value={editFormData.title}
                onChange={(e) => setEditFormData({ ...editFormData, title: e.target.value })}
                maxLength={100}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '1px solid var(--color-border-light)',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  boxSizing: 'border-box',
                  background: 'var(--color-bg)',
                  color: 'var(--color-text-primary)',
                }}
              />
              <p
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--color-text-hint)',
                  margin: '0.25rem 0 0',
                }}
              >
                {editFormData.title.length}/100
              </p>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label
                htmlFor="edit-campaign-description"
                style={{
                  display: 'block',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                  color: 'var(--color-text-primary)',
                }}
              >
                Description
              </label>
              <textarea
                id="edit-campaign-description"
                value={editFormData.description}
                onChange={(e) =>
                  setEditFormData({
                    ...editFormData,
                    description: e.target.value,
                  })
                }
                maxLength={1000}
                rows={5}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '1px solid var(--color-border-light)',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                  background: 'var(--color-bg)',
                  color: 'var(--color-text-primary)',
                }}
              />
              <p
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--color-text-hint)',
                  margin: '0.25rem 0 0',
                }}
              >
                {editFormData.description.length}/1000
              </p>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label
                htmlFor="edit-campaign-deadline"
                style={{
                  display: 'block',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                  color: 'var(--color-text-primary)',
                }}
              >
                Deadline (optional)
              </label>
              <input
                id="edit-campaign-deadline"
                type="date"
                value={editFormData.deadline}
                onChange={(e) => setEditFormData({ ...editFormData, deadline: e.target.value })}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '1px solid var(--color-border-light)',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  boxSizing: 'border-box',
                  background: 'var(--color-bg)',
                  color: 'var(--color-text-primary)',
                }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                gap: '1rem',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={handleRequestCloseEditModal}
                disabled={editLoading}
                style={{ opacity: editLoading ? 0.6 : 1 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSaveEdit}
                disabled={editLoading}
                style={{ opacity: editLoading ? 0.6 : 1 }}
              >
                {editLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Campaign Confirmation Dialog */}
      {showDeleteDialog && campaign && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            ref={deleteModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-campaign-modal-title"
            tabIndex={-1}
            style={{
              background: 'var(--color-surface)',
              borderRadius: '8px',
              padding: '2rem',
              maxWidth: '500px',
              width: '90%',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            }}
          >
            <h2
              id="delete-campaign-modal-title"
              style={{
                fontSize: '1.5rem',
                fontWeight: 700,
                marginBottom: '1rem',
                color: 'var(--color-text-primary)',
              }}
            >
              Delete Campaign
            </h2>
            <p
              style={{
                fontSize: '0.95rem',
                color: 'var(--color-text-secondary)',
                marginBottom: '1.5rem',
                lineHeight: 1.5,
              }}
            >
              Are you sure you want to delete this campaign? This action cannot be undone. All
              contribution and withdrawal history will be preserved, but the campaign will no longer
              be visible to the public.
            </p>
            <div style={{ marginBottom: '1.5rem' }}>
              <label
                htmlFor="delete-campaign-confirm"
                style={{
                  display: 'block',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                  fontSize: '0.9rem',
                  color: 'var(--color-text-primary)',
                }}
              >
                Type the campaign title to confirm:
              </label>
              <input
                id="delete-campaign-confirm"
                type="text"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
                placeholder={campaign.title}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '1px solid var(--color-border)',
                  borderRadius: '4px',
                  fontSize: '1rem',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            {deleteError && (
              <p
                role="alert"
                className="alert alert--error"
                style={{ marginBottom: "1.5rem" }}
              >
                {deleteError}
              </p>
            )}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={closeDeleteDialog}
                disabled={deleteLoading}
                style={{ opacity: deleteLoading ? 0.6 : 1 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleDeleteCampaign}
                disabled={deleteLoading || deleteConfirmation !== campaign.title}
                style={{
                  opacity: deleteLoading || deleteConfirmation !== campaign.title ? 0.6 : 1,
                  background: 'var(--color-danger, #dc2626)',
                  borderColor: 'var(--color-danger, #dc2626)',
                }}
              >
                {deleteLoading ? 'Deleting...' : 'Delete Campaign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

const styles = {
  header: { marginBottom: '1.5rem' },
  badgeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  asset: {
    background: 'var(--color-accent-lightest)',
    color: 'var(--color-accent)',
    fontSize: '0.75rem',
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: '99px',
  },
  title: {
    fontSize: '1.8rem',
    fontWeight: 800,
    margin: '0.5rem 0',
    color: 'var(--color-text-primary)',
  },
  creator: {
    color: 'var(--color-text-hint)',
    fontSize: '0.9rem',
    marginBottom: '0.5rem',
  },
  desc: {
    color: 'var(--color-text-secondary)',
    fontSize: '1rem',
    lineHeight: 1.6,
  },
  card: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '10px',
    padding: '1.5rem',
    marginBottom: '1rem',
  },
  amounts: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '1rem',
  },
  big: {
    fontSize: '1.5rem',
    fontWeight: 800,
    color: 'var(--color-text-primary)',
  },
  small: { fontSize: '0.85rem', color: 'var(--color-text-secondary)' },
  bar: {
    background: 'var(--color-surface)',
    borderRadius: '99px',
    height: '8px',
    marginBottom: '1.25rem',
    overflow: 'hidden',
  },
  fill: {
    background: 'var(--color-accent)',
    height: '100%',
    borderRadius: '99px',
  },
  cta: { width: '100%', padding: '0.85rem', fontSize: '1rem' },
  walletInfo: {
    background: 'var(--color-surface)',
    borderRadius: '8px',
    padding: '0.75rem 1rem',
    marginBottom: '1.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  walletLabel: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
    textTransform: 'uppercase',
  },
  walletKey: {
    fontSize: '0.8rem',
    color: 'var(--color-text-hint)',
    wordBreak: 'break-all',
  },
  detailCoverImage: {
    width: '100%',
    borderRadius: '14px',
    marginBottom: '1.5rem',
    objectFit: 'cover',
    maxHeight: '360px',
  },
  detailCoverPlaceholder: {
    width: '100%',
    borderRadius: '14px',
    marginBottom: '1.5rem',
    height: '260px',
    background: 'linear-gradient(135deg, var(--color-accent-lightest, #ede9fe) 0%, #e0e7ff 100%)',
    border: '1px solid var(--color-accent-lighter, #ddd6fe)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailCoverPlaceholderText: { color: 'var(--color-accent, #6d28d9)', fontWeight: 700 },
  sectionTitle: {
    fontSize: '1.1rem',
    fontWeight: 700,
    marginBottom: '0.75rem',
  },
  list: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-lighter)',
    borderRadius: '6px',
    padding: '0.6rem 0.85rem',
  },
  sender: {
    fontSize: '0.85rem',
    color: 'var(--color-text-secondary)',
    fontFamily: 'monospace',
  },
  amount: { fontSize: '0.85rem', fontWeight: 600, flexShrink: 0 },
  convHint: {
    fontSize: '0.72rem',
    color: 'var(--color-text-secondary)',
    marginTop: '0.15rem',
  },
  refundTag: {
    marginTop: '0.45rem',
    fontSize: '0.75rem',
    color: 'var(--color-accent)',
    fontWeight: 700,
  },
  liveIndicator: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginLeft: '0.5rem',
    fontSize: '0.72rem',
    fontWeight: 600,
    color: 'var(--color-success-text)',
    verticalAlign: 'middle',
  },
  liveDot: {
    display: 'inline-block',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: 'var(--color-success-text)',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  embedCode: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '6px',
    padding: '0.75rem',
    fontSize: '0.75rem',
    fontFamily: 'monospace',
    color: 'var(--color-text-primary)',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    paddingRight: '5rem',
  },
  embedSummary: {
    cursor: 'pointer',
    fontSize: '0.85rem',
    color: 'var(--color-accent)',
    fontWeight: 600,
  },
  emptyBackers: {
    padding: '2.5rem 1rem',
    textAlign: 'center',
    background: 'var(--color-accent-lightest)',
    border: '2px dashed var(--color-accent-lighter)',
    borderRadius: '12px',
    color: 'var(--color-accent)',
    fontWeight: 700,
  },
  avatar: {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    background: 'var(--color-accent-lightest)',
    color: 'var(--color-accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.9rem',
    fontWeight: 800,
    flexShrink: 0,
  },
};
