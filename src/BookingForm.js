
import React, { useEffect, useMemo, useState } from 'react';

export default function BookingForm({ triggerRefresh, token }) {
  const [form, setForm] = useState({
    first: '',
    last: '',
    hut_number: '',
    room: '',
    email: '',
    phone: '',
    debug_mode: false
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [conflictFields, setConflictFields] = useState([]);
  const [palapas, setPalapas] = useState([]);
  const [palapasDate, setPalapasDate] = useState('');
  const [loadingPalapas, setLoadingPalapas] = useState(false);
  const [palapaError, setPalapaError] = useState('');
  const [hutSearch, setHutSearch] = useState('');
  const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

  useEffect(() => {
    const loadPalapas = async () => {
      setLoadingPalapas(true);
      setPalapaError('');
      try {
        const res = await fetch(`${API}/palapas`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load huts');
        setPalapas(Array.isArray(data.palapas) ? data.palapas : []);
        setPalapasDate(data.book_date || '');
      } catch (err) {
        setPalapaError(err.message || 'Failed to load huts');
      } finally {
        setLoadingPalapas(false);
      }
    };
    loadPalapas();
  }, [API, token]);

  const filteredPalapas = useMemo(() => {
    const needle = hutSearch.trim().toLowerCase();
    if (!needle) return palapas.slice(0, 80);
    return palapas.filter((palapa) =>
      [
        palapa.name,
        palapa.zone_name,
        palapa.palapatype_name,
        palapa.status_label
      ].some((value) => String(value || '').toLowerCase().includes(needle))
    ).slice(0, 80);
  }, [hutSearch, palapas]);

  const selectedPalapa = useMemo(
    () => palapas.find((palapa) => String(palapa.name) === String(form.hut_number)),
    [palapas, form.hut_number]
  );

  const handleChange = (e) => {
    const { name, type, checked, value } = e.target;
    setForm({ ...form, [name]: type === 'checkbox' ? checked : value });
    setError('');
    setSuccess('');
    setConflictFields([]);
  };

  const handlePalapaSelect = (e) => {
    const hutNumber = e.target.value;
    setForm({ ...form, hut_number: hutNumber });
    setError('');
    setSuccess('');
    setConflictFields([]);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    const submission = {
      ...form,
      name: `${form.first} ${form.last}`.trim()
    };

    try {
      const res = await fetch(`${API}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(submission)
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess(form.debug_mode ? "Debug booking scheduled!" : "Booking scheduled!");
        setForm({ first: '', last: '', hut_number: '', room: '', email: '', phone: '', debug_mode: false });
        setHutSearch('');
        setConflictFields([]);
        triggerRefresh?.();
      } else {
        if (data?.messages?.length) {
          setError(data.messages.join(" "));
        } else if (data?.conflicting_fields?.length) {
          setConflictFields(data.conflicting_fields);
          setError(`Conflict with: ${data.conflicting_fields.join(', ')}`);
        } else {
          setError(data?.error || "Failed to schedule booking");
        }
      }
    } catch (err) {
      setError("Network or server error occurred");
    }

    setSubmitting(false);
  };

  return (
    <div style={styles.container}>
      <h2 style={styles.heading}>Schedule a Palapa Booking</h2>
      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.nameRow}>
          <div style={styles.inputGroup}>
            <label style={styles.label}>First Name</label>
            <input
              name="first"
              value={form.first}
              onChange={handleChange}
              placeholder="First Name"
              style={{ ...styles.input, ...(conflictFields.includes('first') ? styles.conflict : {}) }}
              required
            />
          </div>
          <div style={styles.inputGroup}>
            <label style={styles.label}>Last Name</label>
            <input
              name="last"
              value={form.last}
              onChange={handleChange}
              placeholder="Last Name"
              style={{ ...styles.input, ...(conflictFields.includes('last') ? styles.conflict : {}) }}
              required
            />
          </div>
        </div>

        <div style={styles.inputGroup}>
          <label style={styles.label}>Hut</label>
          <input
            value={hutSearch}
            onChange={(e) => setHutSearch(e.target.value)}
            placeholder="Search hut, zone, or status"
            style={styles.input}
          />
          <select
            name="hut_number"
            value={form.hut_number}
            onChange={handlePalapaSelect}
            style={{ ...styles.input, ...(conflictFields.includes('hut_number') ? styles.conflict : {}) }}
            required
            disabled={loadingPalapas}
          >
            <option value="">{loadingPalapas ? 'Loading huts...' : 'Select a hut'}</option>
            {filteredPalapas.map((palapa) => (
              <option key={`${palapa.id}-${palapa.name}`} value={palapa.name}>
                {palapa.name} - {palapa.status_label} - {palapa.booking_time} - {palapa.zone_name || 'No zone'}
              </option>
            ))}
          </select>
          {palapaError && <div style={styles.inlineError}>{palapaError}</div>}
          {selectedPalapa && (
            <div style={styles.hutSummary}>
              <strong>{selectedPalapa.status_label}</strong>
              <span>{selectedPalapa.palapatype_name || 'Palapa'}</span>
              <span>Opens {selectedPalapa.booking_time}</span>
              {palapasDate && <span>{palapasDate}</span>}
            </div>
          )}
        </div>

        {['room', 'email', 'phone'].map((field) => (
          <div key={field} style={styles.inputGroup}>
            <label style={styles.label}>
              {field.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
            </label>
            <input
              name={field}
              type={field === 'email' ? 'email' : 'text'}
              value={form[field]}
              onChange={handleChange}
              placeholder={`Enter ${field.replace('_', ' ')}`}
              style={{ ...styles.input, ...(conflictFields.includes(field) ? styles.conflict : {}) }}
              required
            />
          </div>
        ))}

        <label style={styles.checkboxRow}>
          <input
            name="debug_mode"
            type="checkbox"
            checked={form.debug_mode}
            onChange={handleChange}
            style={styles.checkbox}
          />
          <span>Use debug Lambda</span>
        </label>

        {error && <div style={styles.error}>{error}</div>}
        {success && <div style={styles.success}>{success}</div>}
        <button type="submit" style={styles.button} disabled={submitting}>
          {submitting ? 'Scheduling...' : 'Schedule'}
        </button>
      </form>
    </div>
  );
}

const styles = {
  container: {
    background: '#f9f9f9',
    padding: '1.5rem',
    maxWidth: '600px',
    width: '100%',
    boxSizing: 'border-box',
    margin: '2rem auto',
    borderRadius: '10px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.06)'
  },
  heading: {
    marginBottom: '1.5rem',
    textAlign: 'center',
    color: '#333'
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    width: '100%'
  },
  nameRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '1rem',
    width: '100%'
  },
  inputGroup: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    width: '100%'
  },
  label: {
    marginBottom: '0.25rem',
    fontWeight: '600'
  },
  input: {
    width: '100%',
    padding: '0.6rem',
    fontSize: '1rem',
    borderRadius: '6px',
    border: '1px solid #ccc',
    boxSizing: 'border-box'
  },
  conflict: {
    borderColor: '#b00020',
    backgroundColor: '#ffeaea'
  },
  hutSummary: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    fontSize: '0.85rem',
    color: '#333',
    background: '#eef7f8',
    border: '1px solid #cfe6e8',
    borderRadius: '6px',
    padding: '0.6rem'
  },
  inlineError: {
    color: '#b00020',
    fontWeight: '600',
    fontSize: '0.85rem'
  },
  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontWeight: '600'
  },
  checkbox: {
    width: '1rem',
    height: '1rem'
  },
  button: {
    padding: '0.8rem',
    fontSize: '1rem',
    backgroundColor: '#007bff',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 'bold',
    width: '100%'
  },
  error: {
    color: '#b00020',
    fontWeight: 'bold',
    textAlign: 'center'
  },
  success: {
    color: '#0a972f',
    fontWeight: 'bold',
    textAlign: 'center'
  }
};
