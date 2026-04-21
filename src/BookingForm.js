import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import PalapaMap from './PalapaMap';

function todayIsoInAruba(offsetDays = 1) {
  const now = new Date();
  const arubaMs = now.getTime() + now.getTimezoneOffset() * 60 * 1000 - 4 * 60 * 60 * 1000;
  const aruba = new Date(arubaMs + offsetDays * 24 * 60 * 60 * 1000);
  const y = aruba.getUTCFullYear();
  const m = String(aruba.getUTCMonth() + 1).padStart(2, '0');
  const d = String(aruba.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function checkLogSuccess(messages = []) {
  return messages.some(m =>
    m.includes('"success": "ok"') || m.includes("'success': 'ok'")
  );
}

function parseLogBookingInfo(messages = []) {
  for (const msg of messages) {
    if (msg.includes("'id':") || msg.includes('"id":') || msg.trim().startsWith('{')) {
      try {
        const start = msg.indexOf('{');
        if (start === -1) continue;
        const normalized = msg.slice(start)
          .replace(/'/g, '"').replace(/\bNone\b/g, 'null')
          .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
        const parsed = JSON.parse(normalized);
        const info = parsed?.event || parsed;
        if (info && (info.name || info.hut_number)) return info;
      } catch { /* skip */ }
    }
  }
  return null;
}

const WIZARD_STEPS = [
  { num: 1, label: 'Guests' },
  { num: 2, label: 'Dates' },
  { num: 3, label: 'Hut' },
  { num: 4, label: 'Confirm' },
];

export default function BookingForm({ triggerRefresh, token }) {
  const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

  // Wizard step (always active — no "normal mode")
  const [wizardStep, setWizardStep] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [checkIn, setCheckIn] = useState(() => {
    try { return localStorage.getItem('palapa-checkIn') || todayIsoInAruba(1); } catch { return todayIsoInAruba(1); }
  });
  const [checkOut, setCheckOut] = useState(() => {
    try { return localStorage.getItem('palapa-checkOut') || ''; } catch { return ''; }
  });
  const [excludedDates, setExcludedDates] = useState(new Set());
  const [scheduledDates, setScheduledDates] = useState(new Set());

  // Guest profiles
  const [profiles, setProfiles] = useState([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profileError, setProfileError] = useState('');
  const [editingProfile, setEditingProfile] = useState(null);
  const [profileForm, setProfileForm] = useState({ first: '', last: '', email: '', phone: '', room: '', notification_phone: '', sms_enabled: false });
  const [profileSaving, setProfileSaving] = useState(false);

  const [palapas, setPalapas] = useState([]);
  const [palapasDate, setPalapasDate] = useState('');
  const [loadingPalapas, setLoadingPalapas] = useState(false);
  const [palapaError, setPalapaError] = useState('');
  const [hutSearch, setHutSearch] = useState('');
  const [showUnavailable, setShowUnavailable] = useState(false);

  const [hutChoices, setHutChoices] = useState([]);
  const [viewMode, setViewMode] = useState('grid');
  const [debugMode, setDebugMode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [statusAlerts, setStatusAlerts] = useState([]);
  const prevStatusRef = useRef({});

  const [lastRefresh, setLastRefresh] = useState(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [countdown, setCountdown] = useState('');
  const [bookingStatus, setBookingStatus] = useState(null);
  const [recentLogs, setRecentLogs] = useState([]);

  // Persist trip dates to localStorage
  useEffect(() => {
    try { localStorage.setItem('palapa-checkIn', checkIn); } catch {}
  }, [checkIn]);
  useEffect(() => {
    try { localStorage.setItem('palapa-checkOut', checkOut); } catch {}
  }, [checkOut]);

  // Auto-bump past check-in dates
  useEffect(() => {
    const today = todayIsoInAruba(0);
    if (checkIn < today) setCheckIn(today);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // All dates in the selected range
  const allRangeDates = useMemo(() => {
    if (!checkOut || checkOut <= checkIn) return [checkIn];
    const dates = [];
    let d = new Date(checkIn + 'T12:00:00');
    const end = new Date(checkOut + 'T12:00:00');
    while (d <= end) {
      dates.push(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() + 1);
    }
    return dates;
  }, [checkIn, checkOut]);

  // Dates to actually book (range minus exclusions)
  const bookDates = useMemo(() => {
    return allRangeDates.filter(d => !excludedDates.has(d));
  }, [allRangeDates, excludedDates]);

  const isMultiDay = bookDates.length > 1;

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  // --- Load profiles ---
  const fetchProfiles = useCallback(async () => {
    setProfilesLoading(true);
    setProfileError('');
    try {
      const res = await fetch(`${API}/profiles`, { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load profiles');
      setProfiles(Array.isArray(data) ? data : []);
    } catch (err) {
      setProfiles([]);
    } finally {
      setProfilesLoading(false);
    }
  }, [API, authHeaders]);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  // Fetch scheduled bookings to mark which dates are covered
  useEffect(() => {
    fetch(`${API}/bookings`, { headers: authHeaders })
      .then(res => res.json())
      .then(data => {
        const dates = new Set();
        (Array.isArray(data) ? data : []).forEach(b => {
          if (b.book_date) dates.add(b.book_date);
        });
        setScheduledDates(dates);
      })
      .catch(() => {});
  }, [API, authHeaders]);

  // Toggle a date on/off within the range
  const toggleDate = (date) => {
    setExcludedDates(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  // Auto-advance wizard to step 2 when profiles already exist
  useEffect(() => {
    if (!profilesLoading && profiles.length > 0 && wizardStep === 1) {
      setWizardStep(2);
    }
  }, [profilesLoading, profiles.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open the add-guest form when on step 1 with no profiles
  useEffect(() => {
    if (wizardStep === 1 && !profilesLoading && profiles.length === 0 && !editingProfile) {
      setEditingProfile('new');
      setProfileForm({ first: '', last: '', email: '', phone: '', room: '', notification_phone: '', sms_enabled: false });
    }
  }, [wizardStep, profilesLoading, profiles.length, editingProfile]);

  // Close profile editing when leaving step 1
  useEffect(() => {
    if (wizardStep !== 1 && editingProfile) {
      setEditingProfile(null);
      setProfileForm({ first: '', last: '', email: '', phone: '', room: '', notification_phone: '', sms_enabled: false });
      setProfileError('');
    }
  }, [wizardStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Profile CRUD ---
  const startAddProfile = () => {
    setEditingProfile('new');
    setProfileForm({ first: '', last: '', email: '', phone: '', room: '', notification_phone: '', sms_enabled: false });
    setProfileError('');
  };

  const startEditProfile = (p) => {
    setEditingProfile(p.id);
    setProfileForm({ first: p.first || '', last: p.last || '', email: p.email || '', phone: p.phone || '', room: p.room || '', notification_phone: p.notification_phone || '', sms_enabled: !!p.sms_enabled });
    setProfileError('');
  };

  const cancelEditProfile = () => {
    setEditingProfile(null);
    setProfileForm({ first: '', last: '', email: '', phone: '', room: '', notification_phone: '', sms_enabled: false });
    setProfileError('');
  };

  const saveProfile = async () => {
    if (profileSaving) return;
    if (!profileForm.email.trim()) { setProfileError('Email is required'); return; }
    setProfileSaving(true);
    setProfileError('');
    try {
      const isNew = editingProfile === 'new';
      const url = isNew ? `${API}/profiles` : `${API}/profiles/${encodeURIComponent(editingProfile)}`;
      const method = isNew ? 'POST' : 'PATCH';
      const res = await fetch(url, { method, headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(profileForm) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      cancelEditProfile();
      await fetchProfiles();
    } catch (err) {
      setProfileError(err.message || 'Failed to save');
    } finally {
      setProfileSaving(false);
    }
  };

  const deleteProfile = async (id) => {
    if (!window.confirm('Remove this guest?')) return;
    try {
      const res = await fetch(`${API}/profiles/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete');
      fetchProfiles();
    } catch (err) {
      setProfileError(err.message || 'Failed to delete');
    }
  };

  // --- Refresh palapas ---
  const refreshPalapas = useCallback(async () => {
    if (!checkIn) return;
    setLoadingPalapas(true);
    setPalapaError('');
    try {
      const res = await fetch(`${API}/palapas?book_date=${encodeURIComponent(checkIn)}`, { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load huts');
      setPalapas(Array.isArray(data.palapas) ? data.palapas : []);
      setPalapasDate(data.book_date || checkIn);
      setLastRefresh(new Date());
    } catch (err) {
      setPalapaError(err.message || 'Failed to load huts');
    } finally {
      setLoadingPalapas(false);
    }
  }, [API, authHeaders, checkIn]);

  useEffect(() => { refreshPalapas(); }, [refreshPalapas]);

  // --- Monitor selected huts for status changes ---
  useEffect(() => {
    if (!hutChoices.length || !palapas.length) return;
    const byName = {};
    palapas.forEach((p) => { byName[String(p.name)] = p; });
    const prev = prevStatusRef.current;
    const alerts = [];
    hutChoices.forEach((hut) => {
      const p = byName[hut];
      if (!p) return;
      const prevEntry = prev[hut];
      if (prevEntry && prevEntry.available && !p.available) {
        const label = p.status === 5 ? 'Staff Hold' : p.status === 2 ? 'Booked' : p.status_label || 'Unavailable';
        alerts.push({ hut, label, status: p.status });
      }
    });
    if (alerts.length) setStatusAlerts((a) => [...a, ...alerts]);
    const snap = {};
    hutChoices.forEach((hut) => {
      const p = byName[hut];
      if (p) snap[hut] = { available: p.available, status: p.status };
    });
    prevStatusRef.current = snap;
  }, [palapas, hutChoices]);

  // --- Derived data ---
  const availablePalapas = useMemo(() => palapas.filter((p) => p.available), [palapas]);

  const primaryPalapa = useMemo(
    () => palapas.find((p) => String(p.name) === String(hutChoices[0])),
    [palapas, hutChoices]
  );

  const bookNowStatus = useMemo(() => {
    if (!primaryPalapa) return { enabled: false, reason: 'Pick a hut first' };
    const { allowed, label } = bookNowWindow(checkIn, primaryPalapa);
    if (!allowed) return { enabled: false, reason: `Available after ${label}` };
    return { enabled: true, reason: '' };
  }, [checkIn, primaryPalapa]);

  const types = useMemo(() => [...new Set(palapas.map(p => p.palapatype_name).filter(Boolean))], [palapas]);

  const lockedType = useMemo(() => {
    if (!hutChoices.length || !palapas.length) return null;
    const first = palapas.find(p => String(p.name) === hutChoices[0]);
    return first?.palapatype_name || null;
  }, [hutChoices, palapas]);

  useEffect(() => {
    if (lockedType) setTypeFilter(lockedType);
    else if (hutChoices.length === 0) setTypeFilter('all');
  }, [lockedType, hutChoices.length]);

  const filteredPalapas = useMemo(() => {
    let pool = showUnavailable ? palapas : availablePalapas;
    if (typeFilter !== 'all') pool = pool.filter(p => p.palapatype_name === typeFilter);
    const needle = hutSearch.trim().toLowerCase();
    if (!needle) return pool.slice(0, 120);
    return pool.filter((p) =>
      [p.name, p.zone_name, p.palapatype_name, p.status_label]
        .some((v) => String(v || '').toLowerCase().includes(needle))
    ).slice(0, 120);
  }, [hutSearch, palapas, availablePalapas, showUnavailable, typeFilter]);

  // --- Adaptive auto-polling ---
  useEffect(() => {
    if (!checkIn) return;
    const getDelay = () => {
      if (!primaryPalapa) return 5 * 60 * 1000;
      const { windowStartMs } = bookNowWindow(checkIn, primaryPalapa);
      const msUntil = windowStartMs - Date.now();
      if (msUntil <= 0 && msUntil > -60 * 60 * 1000) return 60 * 1000;
      if (msUntil > 0 && msUntil <= 30 * 60 * 1000) return 2 * 60 * 1000;
      return 5 * 60 * 1000;
    };
    let timer;
    const schedule = () => {
      timer = setTimeout(() => { refreshPalapas(); schedule(); }, getDelay());
    };
    schedule();
    return () => clearTimeout(timer);
  }, [checkIn, primaryPalapa, refreshPalapas]);

  // --- Countdown timer ---
  useEffect(() => {
    if (!primaryPalapa || !checkIn) { setCountdown(''); return; }
    const { windowStartMs } = bookNowWindow(checkIn, primaryPalapa);
    const tick = () => {
      const diff = windowStartMs - Date.now();
      if (diff <= 0) { setCountdown('open'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [primaryPalapa, checkIn]);

  // --- Fetch recent logs ---
  useEffect(() => {
    fetch(`${API}/logs`, { headers: authHeaders })
      .then(res => res.json())
      .then(data => {
        setRecentLogs((data.streams || [])
          .sort((a, b) => (b.lastEventTime || 0) - (a.lastEventTime || 0))
          .slice(0, 5));
      })
      .catch(() => {});
  }, [API, authHeaders]);

  // --- Hut choice ---
  const addHutChoice = (name) => {
    if (!name) return;
    if (lockedType) {
      const p = palapas.find(pal => String(pal.name) === String(name));
      if (p && p.palapatype_name !== lockedType) return;
    }
    setError(''); setSuccess('');
    setHutChoices((prev) => (prev.includes(String(name)) ? prev : [...prev, String(name)]));
  };
  const removeHutChoice = (name) => setHutChoices((prev) => prev.filter((h) => h !== String(name)));
  const moveHutChoice = (name, delta) => setHutChoices((prev) => {
    const idx = prev.indexOf(String(name)); if (idx < 0) return prev;
    const next = [...prev]; const t = idx + delta; if (t < 0 || t >= next.length) return prev;
    [next[idx], next[t]] = [next[t], next[idx]]; return next;
  });

  // --- Submit ---
  const submitBody = () => ({ book_dates: bookDates, hut_choices: hutChoices, debug_mode: debugMode });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!bookDates.length) { setError('Select at least one day.'); return; }
    if (!hutChoices.length) { setError('Choose at least one hut.'); return; }
    if (!profiles.length) { setError('Add at least one guest first.'); return; }
    setSubmitting(true); setError(''); setSuccess('');
    try {
      const res = await fetch(`${API}/bookings`, { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(submitBody()) });
      const data = await res.json();
      if (res.ok) {
        const count = data.created?.length || 1;
        const errCount = data.errors?.length || 0;
        let msg = count > 1 ? `${count} bookings scheduled!` : (debugMode ? 'Test booking scheduled!' : 'Booking scheduled!');
        if (errCount > 0) msg += ` (${errCount} date(s) skipped — no available guest)`;
        if (data.availability_warnings?.length) {
          const warnHuts = data.availability_warnings.map(w => w.hut).join(', ');
          msg += ` Note: ${warnHuts} currently unavailable — bot will still attempt at booking time.`;
        }
        setSuccess(msg);
        setHutChoices([]); setHutSearch(''); setExcludedDates(new Set()); triggerRefresh?.();
      } else setError(data.error || 'Failed to schedule booking');
    } catch { setError('Network or server error occurred'); }
    finally { setSubmitting(false); }
  };

  const handleBookNow = async () => {
    if (booking) return;
    if (!hutChoices.length) { setError('Choose at least one hut.'); return; }
    if (!profiles.length) { setError('Add at least one guest first.'); return; }
    setBooking(true); setError(''); setSuccess('');
    setBookingStatus({ state: 'sending', huts: [...hutChoices] });
    try {
      const res = await fetch(`${API}/bookings/now`, { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ book_date: checkIn, hut_choices: hutChoices, debug_mode: debugMode }) });
      const data = await res.json();
      if (res.ok || res.status === 202) {
        setBookingStatus({ state: 'triggered', huts: data.hut_choices || hutChoices, id: data.id, profileName: data.profile_name, startTime: Date.now() });
        setHutChoices([]);
        triggerRefresh?.(3000);
      } else if (res.status === 403 && data.allowed_after_local) {
        setBookingStatus(null);
        setError(`Too early. Try again after ${data.allowed_after_local}.`);
      } else {
        setBookingStatus(null);
        setError(data.error || 'Failed to book');
      }
    } catch {
      setBookingStatus(null);
      setError('Network or server error occurred');
    } finally { setBooking(false); }
  };

  // --- Format date for display ---
  const formatDate = (d) => {
    const dt = new Date(d + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  // ===================================================================
  //  RENDER
  // ===================================================================

  const renderStepIndicator = () => (
    <div className="wz-steps">
      {WIZARD_STEPS.map((s) => (
        <div
          key={s.num}
          className={`wz-step ${wizardStep === s.num ? 'wz-step--active' : ''} ${wizardStep > s.num ? 'wz-step--done' : ''}`}
          onClick={() => { if (s.num < wizardStep) setWizardStep(s.num); }}
          style={s.num < wizardStep ? { cursor: 'pointer' } : {}}
        >
          <span className="wz-step-num">{wizardStep > s.num ? '\u2713' : s.num}</span>
          <span className="wz-step-label">{s.label}</span>
        </div>
      ))}
    </div>
  );

  /* ---------- STEP 1: GUESTS ---------- */
  const renderStep1 = () => (
    <div className="wz-panel wz-fade-in">
      <h2 className="wz-title">Who's Staying?</h2>
      <p className="wz-subtitle">
        Add the guest info used to reserve your palapa on iPoolside. You need at least one guest to continue.
      </p>

      {profilesLoading ? <p className="text-muted">Loading guests...</p> : (
        <>
          {profiles.length === 0 && editingProfile !== 'new' && (
            <p className="text-muted" style={{ textAlign: 'center' }}>No guests added yet.</p>
          )}

          <div className="profiles-list">
            {profiles.map((p) => (
              editingProfile === p.id ? (
                <ProfileFormInline key={p.id} form={profileForm} onChange={setProfileForm} onSave={saveProfile} onCancel={cancelEditProfile} saving={profileSaving} error={profileError} />
              ) : (
                <div key={p.id} className="profile-card">
                  <div className="profile-card-info">
                    <strong>{p.name || `${p.first} ${p.last}`.trim() || '\u2014'}</strong>
                    <span className="text-muted">{p.email}</span>
                    <span className="text-muted">Room {p.room || '\u2014'}</span>
                  </div>
                  <div className="profile-card-actions">
                    <button type="button" onClick={() => startEditProfile(p)} className="btn btn-ghost btn-sm">Edit</button>
                    <button type="button" onClick={() => deleteProfile(p.id)} className="btn btn-danger btn-sm">Remove</button>
                  </div>
                </div>
              )
            ))}
          </div>

          {editingProfile === 'new' ? (
            <ProfileFormInline form={profileForm} onChange={setProfileForm} onSave={saveProfile} onCancel={cancelEditProfile} saving={profileSaving} error={profileError} isNew hideCancelButton={profiles.length === 0} />
          ) : (
            <button type="button" onClick={startAddProfile} className="btn btn-ghost btn-sm" style={{ marginTop: '0.5rem' }}>+ Add Another Guest</button>
          )}

          {profileError && editingProfile === null && <div className="msg-error" style={{ marginTop: '0.4rem' }}>{profileError}</div>}
        </>
      )}

      <p className="wz-hint">
        You can add more guests later to book multiple palapas per day (one per guest).
      </p>

      <div className="wz-nav">
        <div />
        <button type="button" className="btn btn-primary btn-lg" disabled={profiles.length === 0} onClick={() => setWizardStep(2)}>
          Continue &rarr;
        </button>
      </div>
    </div>
  );

  /* ---------- STEP 2: DATES ---------- */
  const renderStep2 = () => (
    <div className="wz-panel wz-fade-in">
      <h2 className="wz-title">When Are You Visiting?</h2>
      <p className="wz-subtitle">
        Pick your check-in date. Add a check-out date if you're staying multiple days.
      </p>

      <div className="field-row">
        <div className="field-group">
          <label className="label">Check-in Date</label>
          <input
            type="date"
            value={checkIn}
            min={todayIsoInAruba(0)}
            onChange={(e) => {
              setCheckIn(e.target.value);
              if (checkOut && e.target.value > checkOut) setCheckOut('');
              setExcludedDates(new Set());
              setHutChoices([]);
              setTypeFilter('all');
            }}
            className="input input-lg"
          />
        </div>
        <div className="field-group">
          <label className="label">
            Check-out Date <span className="text-muted" style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            type="date"
            value={checkOut}
            min={checkIn}
            onChange={(e) => { setCheckOut(e.target.value); setExcludedDates(new Set()); }}
            className="input input-lg"
          />
        </div>
      </div>

      {allRangeDates.length > 1 && (
        <div className="date-pills-wrap">
          <p className="text-muted" style={{ marginBottom: '0.35rem' }}>Tap a day to skip it:</p>
          <div className="date-pills">
            {allRangeDates.map(d => {
              const excluded = excludedDates.has(d);
              const scheduled = scheduledDates.has(d);
              const dt = new Date(d + 'T12:00:00');
              const dayName = dt.toLocaleDateString('en-US', { weekday: 'short' });
              const monthDay = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
              return (
                <button key={d} type="button" className={`date-pill ${excluded ? 'date-pill--excluded' : 'date-pill--active'} ${scheduled ? 'date-pill--scheduled' : ''}`} onClick={() => toggleDate(d)}>
                  <span className="date-pill-day">{dayName}</span>
                  <span className="date-pill-date">{monthDay}</span>
                  {scheduled && !excluded && <span className="date-pill-badge">Scheduled</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <p className="wz-summary-text">
        {bookDates.length} day{bookDates.length !== 1 ? 's' : ''} selected
        {excludedDates.size > 0 ? ` (${excludedDates.size} skipped)` : ''}
        {bookDates.length === 1 ? `: ${formatDate(bookDates[0])}` : ''}
      </p>

      {palapasDate && <p className="text-muted" style={{ fontSize: '0.82rem' }}>Showing hut availability for {palapasDate}</p>}

      <div className="wz-nav">
        <button type="button" className="btn btn-ghost" onClick={() => setWizardStep(1)}>&larr; Back</button>
        <button type="button" className="btn btn-primary btn-lg" disabled={bookDates.length === 0} onClick={() => setWizardStep(3)}>
          Continue &rarr;
        </button>
      </div>
    </div>
  );

  /* ---------- STEP 3: HUT SELECTION ---------- */
  const renderStep3 = () => (
    <div className="wz-panel wz-fade-in">
      <h2 className="wz-title">Pick Your Hut</h2>
      <p className="wz-subtitle">
        Tap the hut you want most. Then add backups &mdash; if your first pick is taken, we'll automatically try the next one.
      </p>

      <div className="section">
        <div className="hut-section-header">
          <h3 className="section-heading" style={{ margin: 0 }}>
            {!loadingPalapas && <>{availablePalapas.length} huts available</>}
          </h3>
          <div className="hut-section-actions">
            <button type="button" onClick={refreshPalapas} className="btn btn-ghost btn-sm refresh-btn" disabled={loadingPalapas} title="Refresh availability">
              {loadingPalapas ? '\u2026' : '\u21BB'}
            </button>
            <div className="view-toggle">
              <button type="button" className={`view-toggle-btn ${viewMode === 'grid' ? 'view-toggle-btn--active' : ''}`} onClick={() => setViewMode('grid')}>Grid</button>
              <button type="button" className={`view-toggle-btn ${viewMode === 'map' ? 'view-toggle-btn--active' : ''}`} onClick={() => setViewMode('map')}>Map</button>
            </div>
          </div>
        </div>

        {lastRefresh && (
          <p className="auto-refresh-info">Updated {timeAgo(lastRefresh.getTime())}</p>
        )}

        {loadingPalapas && <p className="text-muted">Loading huts...</p>}
        {palapaError && <p className="msg-error" style={{ marginTop: '0.4rem' }}>{palapaError}</p>}

        {!loadingPalapas && palapas.length > 0 && (
          <div className="filter-bar">
            <div className="filter-group">
              <span className="filter-label">Type</span>
              <button type="button" className={`filter-pill ${typeFilter === 'all' ? 'filter-pill--active' : ''}`} onClick={() => setTypeFilter('all')}>All</button>
              {types.map(t => (
                <button key={t} type="button" className={`filter-pill ${typeFilter === t ? 'filter-pill--active' : ''}`} onClick={() => !lockedType && setTypeFilter(t)} disabled={!!lockedType && t !== lockedType}>
                  {t.replace(/ reservation/i, '')}
                </button>
              ))}
            </div>
            {lockedType && (
              <p className="text-muted" style={{ marginTop: '0.2rem', fontSize: '0.78rem' }}>
                Backups must be the same type ({lockedType.replace(/ reservation/i, '')}) to share the booking window.
              </p>
            )}
          </div>
        )}

        {viewMode === 'map' ? (
          !loadingPalapas && palapas.length > 0 && (
            <PalapaMap palapas={palapas} hutChoices={hutChoices} onAddChoice={addHutChoice} onRemoveChoice={removeHutChoice} typeFilter={typeFilter} />
          )
        ) : (
          <>
            <input value={hutSearch} onChange={(e) => setHutSearch(e.target.value)} placeholder="Search by name, zone, or type..." className="input" />
            <label className="checkbox-row" style={{ marginTop: '0.35rem' }}>
              <input type="checkbox" checked={showUnavailable} onChange={(e) => setShowUnavailable(e.target.checked)} />
              <span>Show unavailable huts</span>
            </label>

            {!loadingPalapas && filteredPalapas.length === 0 && (
              <p className="text-muted" style={{ marginTop: '0.5rem' }}>
                {availablePalapas.length === 0 ? 'No huts available for this date.' : 'No huts match your search.'}
              </p>
            )}

            <div className="hut-grid">
              {filteredPalapas.map((p) => {
                const chosenIdx = hutChoices.indexOf(String(p.name));
                const isChosen = chosenIdx >= 0;
                const typeMismatch = lockedType && p.palapatype_name !== lockedType;
                const clickable = !isChosen && !typeMismatch;
                const cls = ['hut-pill', isChosen && 'hut-pill--chosen', !p.available && 'hut-pill--unavailable', p.status === 5 && 'hut-pill--staff-hold'].filter(Boolean).join(' ');
                return (
                  <button type="button" key={`${p.id}-${p.name}`} className={cls} onClick={() => clickable && addHutChoice(p.name)} disabled={!clickable} title={p.lock_reason || p.status_label}>
                    <strong>{p.name}</strong>
                    <span>{p.palapatype_name || 'Palapa'}</span>
                    <span className="text-muted">{p.zone_name || '\u2014'}</span>
                    <span className="text-secondary">{p.status_label}</span>
                    {isChosen && <span className="priority-badge">{chosenIdx + 1}</span>}
                    {isChosen && !p.available && <span className="priority-warn-badge">!</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Selected huts */}
      <div className="section" style={{ marginTop: '0.75rem' }}>
        <h3 className="section-heading">Your Picks</h3>
        {hutChoices.length === 0 ? (
          <p className="text-muted">Tap a hut above to select it. Your first pick is your top choice.</p>
        ) : (
          <ul className="priority-list">
            {hutChoices.map((h, idx) => {
              const palapa = palapas.find((p) => String(p.name) === h);
              return (
                <li key={h} className="priority-item">
                  <div className="priority-label">
                    <span className="priority-rank">{idx + 1}</span>
                    <strong>{h}</strong>
                    {palapa?.palapatype_name && <span className="text-muted">{palapa.palapatype_name}</span>}
                    {palapa?.zone_name && <span className="text-muted">{palapa.zone_name}</span>}
                    {palapa && !palapa.available && <span className="text-warn">Currently {palapa.status_label} — may open before booking time</span>}
                  </div>
                  <span className="priority-actions">
                    <button type="button" onClick={() => moveHutChoice(h, -1)} disabled={idx === 0} className="btn btn-ghost btn-sm">&#8593;</button>
                    <button type="button" onClick={() => moveHutChoice(h, 1)} disabled={idx === hutChoices.length - 1} className="btn btn-ghost btn-sm">&#8595;</button>
                    <button type="button" onClick={() => removeHutChoice(h)} className="btn btn-danger btn-sm">&#10005;</button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="wz-nav">
        <button type="button" className="btn btn-ghost" onClick={() => setWizardStep(2)}>&larr; Back</button>
        <button type="button" className="btn btn-primary btn-lg" disabled={hutChoices.length === 0} onClick={() => setWizardStep(4)}>
          Review &amp; Confirm &rarr;
        </button>
      </div>
    </div>
  );

  /* ---------- STEP 4: REVIEW & CONFIRM ---------- */
  const renderStep4 = () => (
    <div className="wz-panel wz-fade-in">
      <h2 className="wz-title">Review &amp; Confirm</h2>
      <p className="wz-subtitle">
        Double-check your selections below, then schedule your booking.
      </p>

      {/* Review summary — tap a row to jump back and edit */}
      <div className="wz-review">
        <div className="wz-review-row" onClick={() => setWizardStep(1)}>
          <span className="wz-review-label">Guest{profiles.length > 1 ? 's' : ''}</span>
          <span className="wz-review-value">
            {profiles.map(p => p.name || `${p.first} ${p.last}`.trim()).join(', ') || '\u2014'}
          </span>
          <span className="wz-review-edit">Edit</span>
        </div>
        <div className="wz-review-row" onClick={() => setWizardStep(2)}>
          <span className="wz-review-label">Dates</span>
          <span className="wz-review-value">
            {bookDates.length === 1
              ? formatDate(bookDates[0])
              : `${bookDates.length} days: ${formatDate(bookDates[0])} \u2014 ${formatDate(bookDates[bookDates.length - 1])}`
            }
          </span>
          <span className="wz-review-edit">Edit</span>
        </div>
        <div className="wz-review-row" onClick={() => setWizardStep(3)}>
          <span className="wz-review-label">Huts</span>
          <span className="wz-review-value">{hutChoices.join(' \u2192 ') || '\u2014'}</span>
          <span className="wz-review-edit">Edit</span>
        </div>
      </div>

      {/* What happens next */}
      <div className="expectations-card">
        <strong>What happens next?</strong>
        <ul>
          <li>Our bot will automatically try to book your hut the moment the reservation window opens.</li>
          <li>If your first choice is taken, it tries your backups in order.</li>
          <li>Once booked, claim and pay at the pool by 10:00 AM or the spot is released.</li>
        </ul>
      </div>

      {/* Countdown */}
      {countdown && primaryPalapa && (
        <div className={`countdown-bar ${countdown === 'open' ? 'countdown--open' : ''}`}>
          {countdown === 'open' ? (
            <>Booking window is <strong>OPEN</strong> for {primaryPalapa.palapatype_name?.replace(/ reservation/i, '')}</>
          ) : (
            <>{primaryPalapa.palapatype_name?.replace(/ reservation/i, '')} booking opens in <strong>{countdown}</strong></>
          )}
        </div>
      )}

      {/* Status alerts */}
      {statusAlerts.length > 0 && (
        <div className="msg-warn">
          <button type="button" className="dismiss-btn" onClick={() => setStatusAlerts([])}>&#10005;</button>
          <strong>Status changed for your selected huts:</strong>
          <ul>
            {statusAlerts.map((a, i) => (
              <li key={i}>{a.hut} is now <strong>{a.label}</strong></li>
            ))}
          </ul>
        </div>
      )}

      {/* Error / Success */}
      {error && <div className="msg-error">{error}</div>}
      {success && <div className="msg-success">{success}</div>}

      {/* Booking status card */}
      {bookingStatus && (
        <div className={`booking-status-card booking-status--${bookingStatus.state}`}>
          <button type="button" className="dismiss-btn" onClick={() => setBookingStatus(null)}>&#10005;</button>
          <div className="booking-status-header">
            {bookingStatus.state === 'sending' && <><span className="spinner-sm" /> Sending booking request...</>}
            {bookingStatus.state === 'triggered' && <>Booking Sent!</>}
          </div>
          <div className="booking-status-detail">
            Huts: {bookingStatus.huts.join(' \u2192 ')}
            {bookingStatus.profileName && <> &middot; Guest: {bookingStatus.profileName}</>}
          </div>
          {bookingStatus.state === 'triggered' && bookingStatus.startTime && (
            <p className="text-muted" style={{ margin: '0.3rem 0 0' }}>
              Started {timeAgo(bookingStatus.startTime)}. Check the Bookings tab for results.
            </p>
          )}
        </div>
      )}

      {/* Primary action: Schedule */}
      <form onSubmit={handleSubmit}>
        <button type="submit" className="btn btn-primary btn-lg wz-main-action" disabled={submitting || !hutChoices.length || !bookDates.length}>
          {submitting ? 'Scheduling...' : isMultiDay ? `Schedule ${bookDates.length} Days` : 'Schedule Booking'}
        </button>
      </form>

      {/* Secondary action: Book Now (only when window is open + single day) */}
      {bookNowStatus.enabled && !isMultiDay && (
        <button type="button" onClick={handleBookNow} className="btn btn-accent wz-secondary-action" disabled={booking}>
          {booking ? 'Booking...' : 'Book Now (Instant)'}
        </button>
      )}
      {!isMultiDay && !bookNowStatus.enabled && bookNowStatus.reason && hutChoices.length > 0 && (
        <p className="book-now-hint">{bookNowStatus.reason}</p>
      )}

      {/* Advanced options (hidden by default) */}
      {showAdvanced ? (
        <div className="wz-advanced">
          <label className="checkbox-row">
            <input type="checkbox" checked={debugMode} onChange={(e) => setDebugMode(e.target.checked)} />
            <span>Use test mode (debug Lambda)</span>
          </label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAdvanced(false)}>Hide advanced</button>
        </div>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm wz-advanced-toggle" onClick={() => setShowAdvanced(true)}>Advanced options</button>
      )}

      {/* Recent activity */}
      {recentLogs.length > 0 && (
        <div className="section recent-history" style={{ marginTop: '0.75rem' }}>
          <h3 className="section-heading">Recent Activity</h3>
          <div className="recent-list">
            {recentLogs.map((log, i) => {
              const ok = checkLogSuccess(log.messages);
              const info = parseLogBookingInfo(log.messages);
              const ago = log.lastEventTime ? timeAgo(log.lastEventTime) : '';
              return (
                <div key={i} className="recent-item">
                  <span className={`recent-dot ${ok ? 'recent-dot--success' : 'recent-dot--fail'}`} />
                  <span className="recent-name">{info?.name || info?.hut_number || log.streamName || 'Booking'}</span>
                  <span className={`badge ${ok ? 'badge-success' : 'badge-danger'}`}>{ok ? 'Success' : 'Failed'}</span>
                  {ago && <span className="text-muted">{ago}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="wz-nav">
        <button type="button" className="btn btn-ghost" onClick={() => setWizardStep(3)}>&larr; Back</button>
        <div />
      </div>
    </div>
  );

  // ===== MAIN RENDER =====
  return (
    <div className="card booking-form-wrap wz-wrap">
      {renderStepIndicator()}
      {wizardStep === 1 && renderStep1()}
      {wizardStep === 2 && renderStep2()}
      {wizardStep === 3 && renderStep3()}
      {wizardStep === 4 && renderStep4()}
    </div>
  );
}


function ProfileFormInline({ form, onChange, onSave, onCancel, saving, error, isNew, hideCancelButton }) {
  return (
    <div className="profile-edit-form">
      <div className="field-row">
        <div className="field-group">
          <label className="label">First name</label>
          <input type="text" value={form.first} onChange={(e) => onChange({ ...form, first: e.target.value })} className="input" placeholder="Sal" />
        </div>
        <div className="field-group">
          <label className="label">Last name</label>
          <input type="text" value={form.last} onChange={(e) => onChange({ ...form, last: e.target.value })} className="input" placeholder="Faenza" />
        </div>
      </div>
      <div className="field-group">
        <label className="label">Email (must be unique per guest)</label>
        <input type="email" value={form.email} onChange={(e) => onChange({ ...form, email: e.target.value })} className="input" placeholder="you@example.com" />
      </div>
      <div className="field-row">
        <div className="field-group">
          <label className="label">Room number</label>
          <input type="text" value={form.room} onChange={(e) => onChange({ ...form, room: e.target.value })} className="input" placeholder="4521" />
        </div>
        <div className="field-group">
          <label className="label">Phone (for booking)</label>
          <input type="text" value={form.phone} onChange={(e) => onChange({ ...form, phone: e.target.value })} className="input" placeholder="555-123-4567" />
        </div>
      </div>
      <label className="checkbox-row" style={{ marginTop: '0.35rem' }}>
        <input type="checkbox" checked={!!form.sms_enabled} onChange={(e) => {
          const enabling = e.target.checked;
          const updates = { ...form, sms_enabled: enabling };
          if (enabling && !form.notification_phone) updates.notification_phone = '+1';
          onChange(updates);
        }} />
        <span>Send me text updates</span>
      </label>
      {form.sms_enabled && (
        <div className="field-group">
          <label className="label">SMS phone number</label>
          <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
            <input type="tel" value={form.notification_phone || ''} onChange={(e) => onChange({ ...form, notification_phone: e.target.value })} className="input" placeholder="+12125551234" style={{ flex: 1 }} />
            {form.phone && (
              <button type="button" className="btn btn-ghost btn-sm" title="Copy from booking phone" onClick={() => {
                const raw = form.phone.replace(/[^0-9]/g, '');
                onChange({ ...form, notification_phone: '+1' + raw });
              }}>
                Copy phone
              </button>
            )}
          </div>
        </div>
      )}
      {error && <div className="msg-error">{error}</div>}
      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem' }}>
        <button type="button" onClick={onSave} className="btn btn-success" disabled={saving}>{saving ? 'Saving...' : isNew ? 'Save Guest' : 'Save'}</button>
        {!hideCancelButton && onCancel && <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">Cancel</button>}
      </div>
    </div>
  );
}

function bookNowWindow(bookDate, palapa) {
  const palapatype = (palapa?.palapatype_name || '').toLowerCase();
  const isSameDay = palapatype.includes('same day');
  const bookingTime = palapa?.booking_time || (isSameDay ? '07:00' : '17:30');
  const [h, m] = bookingTime.split(':').map((n) => parseInt(n, 10));
  const [by, bm, bd] = bookDate.split('-').map((n) => parseInt(n, 10));
  const fireUtcMs = Date.UTC(by, bm - 1, bd, h + 4, m || 0);
  const adjustedMs = isSameDay ? fireUtcMs : fireUtcMs - 24 * 60 * 60 * 1000;
  const dt = new Date(adjustedMs);
  const allowed = Date.now() >= adjustedMs;
  const label = dt.toLocaleString(undefined, { timeZone: 'America/Aruba', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return { allowed, windowStartMs: adjustedMs, label: `${label} (Aruba time)` };
}
