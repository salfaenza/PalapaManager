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
    setSubmitting(true);

    const submission = {
      ...form,
      name: `${form.first} ${form.last}`.trim()
    };

    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(submission)
      });

      if (res.ok) {
        setSuccess("Booking scheduled!");
        setForm({ first: '', last: '', hut_number: '', room: '', email: '', phone: '' });
        setConflictFields([]);
        if (triggerRefresh) triggerRefresh();
      } else {
        const data = await res.json();
        if (data?.conflicting_fields?.length) {
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
        {Object.keys(form).map(field => (
          <div key={field} style={styles.inputGroup}>
            <label style={styles.label}>{field.replace('_', ' ').toUpperCase()}</label>
            <input
              name={field}
              value={form[field]}
              onChange={handleChange}
              placeholder={`Enter ${field.replace('_', ' ')}`}
              style={{
                ...styles.input,
                ...(conflictFields.includes(field) ? styles.conflict : {})
              }}
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
    background: '#f4f4f4',
    padding: '2rem',
    maxWidth: '500px',
    margin: '2rem auto',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
  },
  heading: {
    marginBottom: '1rem',
    textAlign: 'center',
    color: '#333'
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem'
  },
  inputGroup: {
    display: 'flex',
    flexDirection: 'column'
  },
  label: {
    marginBottom: '0.25rem',
    fontWeight: 'bold'
  },
  input: {
    padding: '0.5rem',
    fontSize: '1rem',
    borderRadius: '4px',
    border: '1px solid #ccc'
  },
  conflict: {
    borderColor: '#b00020',
    backgroundColor: '#ffe6e6'
  },
  button: {
    padding: '0.75rem',
    fontSize: '1rem',
    backgroundColor: '#007bff',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer'
  },
  error: {
    color: '#b00020',
    fontWeight: 'bold'
  },
  success: {
    color: '#0a972f',
    fontWeight: 'bold'
  }
};
