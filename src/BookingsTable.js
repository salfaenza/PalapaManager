import React, { useEffect, useState, useCallback, useMemo } from 'react';

export default function BookingsTable({ token, refreshTrigger }) {
  const [bookings, setBookings] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [newHutInput, setNewHutInput] = useState('');

  const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const fetchBookings = useCallback(() => {
    setLoading(true);
    setError('');
    fetch(`${API}/bookings`, { headers: authHeaders })
      .then(async (res) => {
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Failed with ${res.status}`); }
        return res.json();
      })
      .then(setBookings)
      .catch((err) => { console.error('Failed to fetch bookings', err); setError('Could not load bookings. Try refreshing.'); })
      .finally(() => setLoading(false));
  }, [authHeaders, API]);

  const fetchProfiles = useCallback(() => {
    fetch(`${API}/profiles`, { headers: authHeaders })
      .then(async (res) => {
        if (!res.ok) return;
        return res.json();
      })
      .then((data) => { if (Array.isArray(data)) setProfiles(data); })
      .catch(() => {});
  }, [authHeaders, API]);

  useEffect(() => { fetchBookings(); fetchProfiles(); }, [fetchBookings, fetchProfiles, refreshTrigger]);

  const handleDelete = async (scheduleName) => {
    if (!window.confirm(`Delete schedule "${scheduleName}"?`)) return;
    setDeletingId(scheduleName);
    try {
      const res = await fetch(`${API}/bookings/${encodeURIComponent(scheduleName)}`, { method: 'DELETE', headers: authHeaders });
      if (res.ok) fetchBookings();
      else { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to delete schedule'); }
    } catch { alert('Network error while deleting'); }
    finally { setDeletingId(null); }
  };

  const startEdit = (b) => {
    const choices = Array.isArray(b.hut_choices) && b.hut_choices.length ? b.hut_choices.map(String) : (b.hut_number ? [String(b.hut_number)] : []);
    setEditingId(b.scheduleName);
    setEditForm({ book_date: b.book_date || '', hut_choices: choices, debug_mode: Boolean(b.debug_mode) });
    setNewHutInput('');
    setError('');
  };

  const cancelEdit = () => { setEditingId(null); setEditForm({}); setNewHutInput(''); setError(''); setSaving(false); };

  const moveChoice = (hut, delta) => setEditForm((prev) => {
    const c = [...(prev.hut_choices || [])]; const i = c.indexOf(hut); if (i < 0) return prev;
    const t = i + delta; if (t < 0 || t >= c.length) return prev; [c[i], c[t]] = [c[t], c[i]]; return { ...prev, hut_choices: c };
  });

  const removeChoice = (hut) => setEditForm((prev) => ({ ...prev, hut_choices: (prev.hut_choices || []).filter((h) => h !== hut) }));

  const addChoice = () => {
    const name = newHutInput.trim();
    if (!name) return;
    setEditForm((prev) => { const e = prev.hut_choices || []; if (e.includes(name)) return prev; return { ...prev, hut_choices: [...e, name] }; });
    setNewHutInput('');
  };

  const saveEdit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/bookings/${encodeURIComponent(editingId)}`, {
        method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_date: editForm.book_date, hut_choices: editForm.hut_choices, debug_mode: Boolean(editForm.debug_mode) })
      });
      const data = await res.json();
      if (res.ok) { cancelEdit(); fetchBookings(); }
      else setError(data.error || 'Failed to update booking.');
    } catch { setError('Network error while updating booking.'); }
    finally { setSaving(false); }
  };

  // Change the profile assigned to a booking
  const changeProfile = async (scheduleName, newProfileId) => {
    try {
      const res = await fetch(`${API}/bookings/${encodeURIComponent(scheduleName)}`, {
        method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: newProfileId })
      });
      if (res.ok) fetchBookings();
      else { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to change profile'); }
    } catch { setError('Network error while changing profile.'); }
  };

  // Build a set of profile IDs already used on each date (for dropdown filtering)
  const usedProfilesByDate = useMemo(() => {
    const map = {};
    bookings.forEach((b) => {
      if (b.book_date && b.profile_id) {
        if (!map[b.book_date]) map[b.book_date] = {};
        map[b.book_date][b.profile_id] = b.scheduleName;
      }
    });
    return map;
  }, [bookings]);

  return (
    <div className="card bookings-wrap">
      <h2 className="bookings-title">Scheduled Bookings</h2>
      {loading && <p className="text-muted" style={{ textAlign: 'center' }}>Loading bookings...</p>}
      {error && <div className="msg-error">{error}</div>}

      {!loading && bookings.length === 0 && !error && (
        <p className="text-muted" style={{ textAlign: 'center' }}>No scheduled bookings yet.</p>
      )}

      <div className="bookings-list">
        {bookings.map((b) => (
          <div key={b.scheduleName || b.id} className="booking-card">
            {editingId === b.scheduleName ? (
              <div className="booking-edit">
                <div className="field-group">
                  <label className="label">Booking date</label>
                  <input type="date" value={editForm.book_date || ''} onChange={(e) => setEditForm({ ...editForm, book_date: e.target.value })} className="input" />
                </div>

                <div className="field-group">
                  <label className="label">Priority list</label>
                  <ul className="priority-list">
                    {(editForm.hut_choices || []).map((h, idx) => (
                      <li key={h} className="priority-item">
                        <div className="priority-label">
                          <span className="priority-rank">{idx + 1}</span>
                          <strong>{h}</strong>
                        </div>
                        <span className="priority-actions">
                          <button type="button" onClick={() => moveChoice(h, -1)} disabled={idx === 0} className="btn btn-ghost btn-sm">&#8593;</button>
                          <button type="button" onClick={() => moveChoice(h, 1)} disabled={idx === (editForm.hut_choices || []).length - 1} className="btn btn-ghost btn-sm">&#8595;</button>
                          <button type="button" onClick={() => removeChoice(h)} className="btn btn-danger btn-sm">&#10005;</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="add-row" style={{ marginTop: '0.4rem' }}>
                    <input value={newHutInput} onChange={(e) => setNewHutInput(e.target.value)} placeholder="Hut name to add" className="input" onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addChoice())} />
                    <button type="button" onClick={addChoice} className="btn btn-primary btn-sm">Add</button>
                  </div>
                </div>

                <label className="checkbox-row">
                  <input type="checkbox" checked={Boolean(editForm.debug_mode)} onChange={(e) => setEditForm({ ...editForm, debug_mode: e.target.checked })} />
                  <span>Use debug Lambda</span>
                </label>

                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button onClick={saveEdit} className="btn btn-success btn-sm" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                  <button onClick={cancelEdit} className="btn btn-ghost btn-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="field-row-inline">
                  <span className="field-label">Name</span>
                  <span className="field-value">{b.name || `${b.first || ''} ${b.last || ''}`.trim() || '\u2014'}</span>
                </div>
                <div className="field-row-inline">
                  <span className="field-label">Date</span>
                  <span className="field-value">{b.book_date || '\u2014'}</span>
                </div>
                <div className="field-row-inline">
                  <span className="field-label">Huts</span>
                  <span className="field-value">
                    <HutChain choices={b.hut_choices && b.hut_choices.length ? b.hut_choices : [b.hut_number].filter(Boolean)} />
                  </span>
                </div>
                <div className="field-row-inline">
                  <span className="field-label">Room</span>
                  <span className="field-value">{b.room || '\u2014'}</span>
                </div>
                <div className="field-row-inline">
                  <span className="field-label">Opens</span>
                  <span className="field-value">{b.booking_time || '\u2014'}</span>
                </div>
                <div className="field-row-inline">
                  <span className="field-label">Profile</span>
                  <span className="field-value">
                    <ProfileDropdown
                      booking={b}
                      profiles={profiles}
                      usedOnDate={usedProfilesByDate[b.book_date] || {}}
                      onChange={(profileId) => changeProfile(b.scheduleName, profileId)}
                    />
                  </span>
                </div>
                <div className="field-row-inline">
                  <span className="field-label">Mode</span>
                  <span className={`badge ${b.debug_mode ? 'badge-warn' : 'badge-info'}`}>{b.debug_mode ? 'Debug' : 'Standard'}</span>
                </div>

                <div className="btn-row">
                  <button onClick={() => startEdit(b)} className="btn btn-primary btn-sm">Edit</button>
                  <button onClick={() => handleDelete(b.scheduleName)} className="btn btn-danger btn-sm" disabled={deletingId === b.scheduleName}>
                    {deletingId === b.scheduleName ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfileDropdown({ booking, profiles, usedOnDate, onChange }) {
  // Show dropdown only if there are profiles to choose from
  if (!profiles.length) {
    return <span>{booking.name || booking.creator_email || '\u2014'}</span>;
  }

  const currentProfileId = booking.profile_id || '';

  // Available options: current profile + any profile not used on this date by another booking
  const options = profiles.filter((p) => {
    if (p.id === currentProfileId) return true; // always show current
    const usedBy = usedOnDate[p.id];
    return !usedBy || usedBy === booking.scheduleName; // not used, or used by this same booking
  });

  return (
    <select
      className="profile-select"
      value={currentProfileId}
      onChange={(e) => onChange(e.target.value)}
    >
      {!currentProfileId && <option value="">Unassigned</option>}
      {options.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name || `${p.first || ''} ${p.last || ''}`.trim() || p.email}
        </option>
      ))}
    </select>
  );
}

function HutChain({ choices }) {
  if (!choices.length) return <span>{'\u2014'}</span>;
  return (
    <span className="hut-chain">
      {choices.map((h, idx) => (
        <React.Fragment key={h}>
          {idx > 0 && <span className="hut-arrow">{'\u2192'}</span>}
          <span className={`hut-tag ${idx === 0 ? 'hut-tag--primary' : 'hut-tag--backup'}`}>{h}</span>
        </React.Fragment>
      ))}
    </span>
  );
}
