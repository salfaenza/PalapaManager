import { useEffect, useState, useCallback, useMemo } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

function todayAruba() {
  return new Date(
    new Date().toLocaleString('en-CA', { timeZone: 'America/Aruba', year: 'numeric', month: '2-digit', day: '2-digit' })
  ).toISOString().split('T')[0];
}

export default function BookingResults({ token }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancellingId, setCancellingId] = useState(null);
  const [verifyingId, setVerifyingId] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const fetchResults = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/booking-results`, { headers: authHeaders });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Failed with ${res.status}`);
      }
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to fetch booking results', err);
      setError('Could not load booking results.');
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => { fetchResults(); }, [fetchResults]);

  const handleVerify = async (id) => {
    setVerifyingId(id);
    try {
      const res = await fetch(`${API}/booking-results/${encodeURIComponent(id)}/verify`, {
        method: 'POST',
        headers: authHeaders,
      });
      const data = await res.json();
      if (res.ok) {
        fetchResults();
      } else {
        alert(data.error || 'Failed to verify booking');
      }
    } catch {
      alert('Network error while verifying');
    } finally {
      setVerifyingId(null);
    }
  };

  const handleCancel = async (id) => {
    if (!window.confirm('Cancel this booking on iPoolside? This cannot be undone.')) return;
    setCancellingId(id);
    try {
      const res = await fetch(`${API}/booking-results/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: authHeaders,
      });
      const data = await res.json();
      if (res.ok) {
        fetchResults();
      } else {
        alert(data.error || 'Failed to cancel booking');
      }
    } catch {
      alert('Network error while cancelling');
    } finally {
      setCancellingId(null);
    }
  };

  const today = todayAruba();
  const allConfirmed = results.filter(r => r.status === 'confirmed');
  const allCancelled = results.filter(r => r.status === 'cancelled');
  const confirmed = showAll ? allConfirmed : allConfirmed.filter(r => r.book_date >= today);
  const cancelled = showAll ? allCancelled : allCancelled.filter(r => r.book_date >= today);

  return (
    <div className="card bookings-wrap">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 className="bookings-title" style={{ margin: 0 }}>Confirmed Bookings</h2>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowAll(prev => !prev)}
        >
          {showAll ? 'Today & Future' : 'Show All'}
        </button>
      </div>

      {loading && <p className="text-muted" style={{ textAlign: 'center' }}>Loading your bookings...</p>}
      {error && <div className="msg-error">{error}</div>}

      {!loading && results.length === 0 && !error && (
        <p className="text-muted" style={{ textAlign: 'center' }}>
          No confirmed bookings yet. After the bot successfully books a hut, it will show up here.
        </p>
      )}

      {confirmed.length > 0 && (
        <div className="br-section">
          <h3 className="section-heading">Confirmed</h3>
          <div className="bookings-list">
            {confirmed.map((r) => (
              <BookingResultCard
                key={r.id}
                result={r}
                onCancel={handleCancel}
                cancelling={cancellingId === r.id}
                onVerify={handleVerify}
                verifying={verifyingId === r.id}
              />
            ))}
          </div>
        </div>
      )}

      {cancelled.length > 0 && (
        <div className="br-section" style={{ marginTop: '1rem' }}>
          <h3 className="section-heading">Cancelled Bookings</h3>
          <div className="bookings-list">
            {cancelled.map((r) => (
              <BookingResultCard key={r.id} result={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BookingResultCard({ result, onCancel, cancelling, onVerify, verifying }) {
  const r = result;
  const isConfirmed = r.status === 'confirmed';
  const isCancelled = r.status === 'cancelled';

  const dateLabel = r.book_date || '\u2014';
  const hutLabel = r.hut || '\u2014';
  const profileLabel = r.profile_name || r.profile_email || '\u2014';
  const orderLabel = r.order_number || '\u2014';

  const createdDate = r.created_at
    ? new Date(r.created_at + 'Z').toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '';

  const cancelledDate = r.cancelled_at
    ? new Date(r.cancelled_at + 'Z').toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '';

  const verifiedAt = r.verified_at
    ? new Date(r.verified_at + 'Z').toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '';

  return (
    <div className={`booking-card ${isCancelled ? 'br-card--cancelled' : ''}`}>
      <div className="field-row-inline">
        <span className="field-label">Date</span>
        <span className="field-value">{dateLabel}</span>
      </div>
      <div className="field-row-inline">
        <span className="field-label">Hut</span>
        <span className="field-value">
          <span className="hut-tag hut-tag--primary">{hutLabel}</span>
        </span>
      </div>
      <div className="field-row-inline">
        <span className="field-label">Guest</span>
        <span className="field-value">{profileLabel}</span>
      </div>
      <div className="field-row-inline">
        <span className="field-label">Confirmation #</span>
        <span className="field-value">{orderLabel}</span>
      </div>
      <div className="field-row-inline">
        <span className="field-label">Status</span>
        <span className={`badge ${isConfirmed ? 'badge-success' : 'badge-danger'}`}>
          {isConfirmed ? 'Confirmed' : 'Cancelled'}
        </span>
        {isConfirmed && r.verified && (
          <span className="badge badge-info" style={{ marginLeft: '0.3rem' }} title={verifiedAt ? `Verified ${verifiedAt}` : ''}>
            Verified
          </span>
        )}
        {isConfirmed && r.verified === false && r.verified_at && (
          <span className="badge badge-danger" style={{ marginLeft: '0.3rem' }} title={verifiedAt ? `Checked ${verifiedAt}` : ''}>
            Not on iPoolside
          </span>
        )}
      </div>
      {createdDate && (
        <div className="field-row-inline">
          <span className="field-label">Reserved</span>
          <span className="field-value text-muted">{createdDate}</span>
        </div>
      )}
      {cancelledDate && (
        <div className="field-row-inline">
          <span className="field-label">Cancelled</span>
          <span className="field-value text-muted">{cancelledDate}</span>
        </div>
      )}

      {isConfirmed && (
        <div className="btn-row">
          {r.manage_url && (
            <a
              href={r.manage_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm"
            >
              Manage
            </a>
          )}
          {onVerify && (
            <button
              onClick={() => onVerify(r.id)}
              className="btn btn-primary btn-sm"
              disabled={verifying}
            >
              {verifying ? 'Verifying...' : 'Verify'}
            </button>
          )}
          {onCancel && (
            <button
              onClick={() => onCancel(r.id)}
              className="btn btn-danger btn-sm"
              disabled={cancelling}
            >
              {cancelling ? 'Cancelling...' : 'Cancel'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
