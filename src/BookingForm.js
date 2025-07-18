
import React, { useState } from 'react';

export default function BookingForm({ triggerRefresh, token }) {
  const [form, setForm] = useState({
    first: '',
    last: '',
    hut_number: '',
    room: '',
    email: '',
    phone: ''
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [conflictFields, setConflictFields] = useState([]);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
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
      const res = await fetch(`${process.env.REACT_APP_API_URL || 'http://localhost:5000'}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(submission)
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess("Booking scheduled!");
        setForm({ first: '', last: '', hut_number: '', room: '', email: '', phone: '' });
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

        {['hut_number', 'room', 'email', 'phone'].map((field) => (
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
