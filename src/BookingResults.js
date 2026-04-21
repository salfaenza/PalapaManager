import React, { useEffect, useState, useCallback, useMemo } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

export default function BookingResults({ token }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancellingId, setCancellingId] = useState(null);

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

  const confirmed = results.filter(r => r.status === 'confirmed');
  const cancelled = results.filter(r => r.status === 'cancelled');

  return (
    <div className="card bookings-wrap">
      <h2 className="bookings-title">Completed Bookings</h2>

      {loading && <p className="text-muted" style={{ textAlign: 'center' }}>Loading booking results...</p>}
      {error && <div className="msg-error">{error}</div>}

      {!loading && results.length === 0 && !error && (
        <p className="text-muted" style={{ textAlign: 'center' }}>
          No completed bookings yet. Bookings will appear here after they are confirmed on iPoolside.
        </p>
      )}

      {confirmed.length > 0 && (
        <div className="br-section">
          <h3 className="section-heading">Active Bookings</h3>
          <div className="bookings-list">
            {confirmed.map((r) => (
              <BookingResultCard
                key={r.id}
                result={r}
                onCancel={handleCancel}
                cancelling={cancellingId === r.id}
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

function BookingResultCard({ result, onCancel, cancelling }) {
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
        <span className="field-label">Profile</span>
        <span className="field-value">{profileLabel}</span>
      </div>
      <div className="field-row-inline">
        <span className="field-label">Order</span>
        <span className="field-value">{orderLabel}</span>
      </div>
      <div className="field-row-inline">
        <span className="field-label">Status</span>
        <span className={`badge ${isConfirmed ? 'badge-success' : 'badge-danger'}`}>
          {isConfirmed ? 'Confirmed' : 'Cancelled'}
        </span>
        {r.verified && isConfirmed && (
          <span className="badge badge-info" style={{ marginLeft: '0.3rem' }}>Verified</span>
        )}
      </div>
      {createdDate && (
        <div className="field-row-inline">
          <span className="field-label">Booked</span>
          <span className="field-value text-muted">{createdDate}</span>
        </div>
      )}
      {cancelledDate && (
        <div className="field-row-inline">
          <span className="field-label">Cancelled</span>
          <span className="field-value text-muted">{cancelledDate}</span>
        </div>
      )}

      {isConfirmed && onCancel && (
        <div className="btn-row">
          {r.manage_url && (
            <a
              href={r.manage_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm"
            >
              Manage on iPoolside
            </a>
          )}
          <button
            onClick={() => onCancel(r.id)}
            className="btn btn-danger btn-sm"
            disabled={cancelling}
          >
            {cancelling ? 'Cancelling...' : 'Cancel Booking'}
          </button>
        </div>
      )}
    </div>
  );
}
