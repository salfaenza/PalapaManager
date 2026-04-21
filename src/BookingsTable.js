import { useEffect, useState, useCallback, useMemo, Fragment } from 'react';

function buildDateRange(start, end) {
  if (!start) return [];
  const dates = [];
  let d = new Date(start + 'T12:00:00');
  const stop = end ? new Date(end + 'T12:00:00') : d;
  while (d <= stop) {
    dates.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

export default function BookingsTable({ token, refreshTrigger }) {
  const [bookings, setBookings] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [togglingDate, setTogglingDate] = useState(null); // "groupKey:date" currently in flight
  const [editingGroup, setEditingGroup] = useState(null);
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

  // Group bookings by hut choices (same huts in same order = same group)
  const groupedBookings = useMemo(() => {
    const groups = {};
    bookings.forEach((b) => {
      const choices = Array.isArray(b.hut_choices) && b.hut_choices.length
        ? b.hut_choices.map(String)
        : (b.hut_number ? [String(b.hut_number)] : []);
      const key = choices.join(',');
      if (!groups[key]) {
        groups[key] = {
          key,
          hut_choices: choices,
          booking_time: b.booking_time,
          palapatype_name: b.palapatype_name,
          debug_mode: b.debug_mode,
          days: [],
          daysByDate: {},
        };
      }
      groups[key].days.push(b);
      groups[key].daysByDate[b.book_date] = b;
    });
    Object.values(groups).forEach(g => {
      g.days.sort((a, b) => (a.book_date || '').localeCompare(b.book_date || ''));
    });
    return Object.values(groups);
  }, [bookings]);

  // Build a set of profile IDs already used on each date
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

  // Compute which dates to show for a group:
  // Full range from min(checkIn, earliest scheduled) to max(checkOut, latest scheduled)
  const getDatesForGroup = useCallback((group) => {
    let checkIn = '';
    let checkOut = '';
    try {
      checkIn = localStorage.getItem('palapa-checkIn') || '';
      checkOut = localStorage.getItem('palapa-checkOut') || '';
    } catch {}

    const scheduledDates = group.days.map(d => d.book_date).filter(Boolean).sort();
    const firstScheduled = scheduledDates[0] || '';
    const lastScheduled = scheduledDates[scheduledDates.length - 1] || '';

    // Expand range to cover both trip dates and scheduled dates
    const rangeStart = (checkIn && checkIn < firstScheduled) ? checkIn
      : firstScheduled || checkIn;
    const rangeEnd = (checkOut && checkOut > lastScheduled) ? checkOut
      : lastScheduled || checkOut;

    if (!rangeStart) return scheduledDates; // fallback
    return buildDateRange(rangeStart, rangeEnd || rangeStart);
  }, []);

  // Toggle a date: if scheduled, delete it; if not, create it
  const toggleDate = async (group, date) => {
    const toggleKey = `${group.key}:${date}`;
    if (togglingDate) return; // one at a time
    setTogglingDate(toggleKey);
    setError('');

    const existing = group.daysByDate[date];
    try {
      if (existing) {
        // Remove this day
        const res = await fetch(`${API}/bookings/${encodeURIComponent(existing.scheduleName)}`, { method: 'DELETE', headers: authHeaders });
        if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to remove day'); }
      } else {
        // Add this day
        const res = await fetch(`${API}/bookings`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            book_dates: [date],
            hut_choices: group.hut_choices,
            debug_mode: group.debug_mode || false,
          }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to add day'); }
      }
      fetchBookings();
    } catch { setError('Network error'); }
    finally { setTogglingDate(null); }
  };

  const handleDeleteGroup = async (group) => {
    if (!window.confirm(`Delete all ${group.days.length} day(s) for hut ${group.hut_choices[0]}?`)) return;
    for (const day of group.days) {
      try {
        await fetch(`${API}/bookings/${encodeURIComponent(day.scheduleName)}`, { method: 'DELETE', headers: authHeaders });
      } catch {}
    }
    fetchBookings();
  };

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

  // --- Group-level hut editing ---
  const startEditGroup = (group) => {
    setEditingGroup(group.key);
    setEditForm({ hut_choices: [...group.hut_choices], debug_mode: group.debug_mode });
    setNewHutInput('');
    setError('');
  };

  const cancelEditGroup = () => { setEditingGroup(null); setEditForm({}); setNewHutInput(''); setError(''); setSaving(false); };

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

  const saveGroupEdit = async (group) => {
    if (saving) return;
    setSaving(true);
    try {
      for (const day of group.days) {
        const res = await fetch(`${API}/bookings/${encodeURIComponent(day.scheduleName)}`, {
          method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_date: day.book_date, hut_choices: editForm.hut_choices, debug_mode: Boolean(editForm.debug_mode) })
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error || `Failed to update booking for ${day.book_date}`);
          setSaving(false);
          return;
        }
      }
      cancelEditGroup();
      fetchBookings();
    } catch { setError('Network error while updating bookings.'); }
    finally { setSaving(false); }
  };

  return (
    <div className="card bookings-wrap">
      <h2 className="bookings-title">Upcoming Reservations</h2>
      {loading && <p className="text-muted" style={{ textAlign: 'center' }}>Loading bookings...</p>}
      {error && <div className="msg-error">{error}</div>}

      {!loading && groupedBookings.length === 0 && !error && (
        <p className="text-muted" style={{ textAlign: 'center' }}>No upcoming reservations yet. Schedule a booking above to get started.</p>
      )}

      <div className="bookings-list">
        {groupedBookings.map((group) => {
          const allDates = getDatesForGroup(group);
          const scheduledCount = group.days.length;

          return (
            <div key={group.key} className="booking-card">
              {/* Hut choices header */}
              <div className="field-row-inline">
                <span className="field-label">Huts</span>
                <span className="field-value">
                  <HutChain choices={group.hut_choices} />
                </span>
              </div>
              {group.booking_time && (
                <div className="field-row-inline">
                  <span className="field-label">Books at</span>
                  <span className="field-value">{group.booking_time}</span>
                </div>
              )}
              {group.debug_mode && (
                <div className="field-row-inline">
                  <span className="field-label">Mode</span>
                  <span className="badge badge-warn">Test</span>
                </div>
              )}

              {/* Edit hut choices */}
              {editingGroup === group.key ? (
                <div className="booking-edit" style={{ marginTop: '0.5rem' }}>
                  <div className="field-group">
                    <label className="label">Priority list (applies to all days)</label>
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
                    <button onClick={() => saveGroupEdit(group)} className="btn btn-success btn-sm" disabled={saving}>{saving ? 'Saving...' : 'Save All'}</button>
                    <button onClick={cancelEditGroup} className="btn btn-ghost btn-sm">Cancel</button>
                  </div>
                </div>
              ) : null}

              {/* Day pills — all trip dates, tap to select/deselect */}
              <div className="booking-days" style={{ marginTop: '0.5rem' }}>
                <span className="field-label">{scheduledCount} of {allDates.length} day{allDates.length !== 1 ? 's' : ''} booked</span>
                <div className="booking-day-pills">
                  {allDates.map((date) => {
                    const scheduled = group.daysByDate[date];
                    const isToggling = togglingDate === `${group.key}:${date}`;
                    const dt = new Date(date + 'T12:00:00');
                    const dayName = dt.toLocaleDateString('en-US', { weekday: 'short' });
                    const monthDay = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    return (
                      <button
                        key={date}
                        type="button"
                        className={`date-pill ${scheduled ? 'date-pill--active' : 'date-pill--excluded'} ${isToggling ? 'date-pill--loading' : ''}`}
                        onClick={() => toggleDate(group, date)}
                        disabled={!!togglingDate}
                      >
                        <span className="date-pill-day">{dayName}</span>
                        <span className="date-pill-date">{monthDay}</span>
                        {isToggling && <span className="date-pill-badge">...</span>}
                      </button>
                    );
                  })}
                </div>
                <p className="text-muted" style={{ marginTop: '0.25rem', fontSize: '0.78rem' }}>
                  Tap a day to add or remove it.
                </p>
              </div>

              {/* Per-day profile assignments for scheduled days */}
              {scheduledCount > 0 && (
                <div className="booking-profiles" style={{ marginTop: '0.4rem' }}>
                  <span className="field-label">Guest per day</span>
                  <div className="booking-profile-list">
                    {group.days.map((day) => {
                      const dt = new Date(day.book_date + 'T12:00:00');
                      const label = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                      return (
                        <div key={day.scheduleName} className="booking-profile-row">
                          <span className="booking-profile-date">{label}</span>
                          <ProfileDropdown
                            booking={day}
                            profiles={profiles}
                            usedOnDate={usedProfilesByDate[day.book_date] || {}}
                            onChange={(profileId) => changeProfile(day.scheduleName, profileId)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Action buttons */}
              {editingGroup !== group.key && (
                <div className="btn-row">
                  <button onClick={() => startEditGroup(group)} className="btn btn-primary btn-sm">Change Huts</button>
                  <button onClick={() => handleDeleteGroup(group)} className="btn btn-danger btn-sm">Remove All</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProfileDropdown({ booking, profiles, usedOnDate, onChange }) {
  if (!profiles.length) {
    return <span>{booking.name || booking.creator_email || '\u2014'}</span>;
  }

  const currentProfileId = booking.profile_id || '';

  const options = profiles.filter((p) => {
    if (p.id === currentProfileId) return true;
    const usedBy = usedOnDate[p.id];
    return !usedBy || usedBy === booking.scheduleName;
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
        <Fragment key={h}>
          {idx > 0 && <span className="hut-arrow">{'\u2192'}</span>}
          <span className={`hut-tag ${idx === 0 ? 'hut-tag--primary' : 'hut-tag--backup'}`}>{h}</span>
        </Fragment>
      ))}
    </span>
  );
}
