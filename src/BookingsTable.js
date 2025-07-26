import React, { useEffect, useState, useCallback } from 'react';

export default function BookingsTable({ token, refreshTrigger }) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);

  const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

  const fetchBookings = useCallback(() => {
    setLoading(true);
    setError('');
    fetch(`${API}/bookings`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Failed with ${res.status}`);
        }
        return res.json();
      })
      .then(setBookings)
      .catch(err => {
        console.error("Failed to fetch bookings", err);
        setError("Could not load bookings. Try refreshing.");
      })
      .finally(() => setLoading(false));
  }, [token, API]);

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings, refreshTrigger]);

  const handleDelete = async (scheduleName) => {
    if (!window.confirm(`Delete schedule "${scheduleName}"?`)) return;
    setDeletingId(scheduleName);

    try {
      const res = await fetch(`${API}/bookings/${encodeURIComponent(scheduleName)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.ok) {
        fetchBookings();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Failed to delete schedule");
      }
    } catch (err) {
      console.error("Delete failed", err);
      alert("Network error while deleting");
    }

    setDeletingId(null);
  };

  const startEdit = (booking) => {
    setEditingId(booking.scheduleName);
    setEditForm({
      ...booking,
      first: booking.first || booking.name?.split(' ')[0] || '',
      last: booking.last || booking.name?.split(' ').slice(-1)[0] || '',
      phone: booking.phone || ''
    });
    setError('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({});
    setError('');
    setSaving(false);
  };

  const saveEdit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const payload = {
        first: editForm.first,
        last: editForm.last,
        name: `${editForm.first} ${editForm.last}`.trim(),
        hut_number: editForm.hut_number,
        room: editForm.room,
        email: editForm.email,
        phone: editForm.phone
      };

      const res = await fetch(`${API}/bookings/${encodeURIComponent(editingId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (res.ok) {
        setEditingId(null);
        setEditForm({});
        fetchBookings();
      } else {
        if (data.messages?.length) {
          setError(data.messages.join(" "));
        } else if (data.conflicting_fields?.length) {
          setError(`Conflict with: ${data.conflicting_fields.join(', ')}`);
        } else {
          setError(data.error || "Failed to update booking.");
        }
      }
    } catch (err) {
      console.error("Update failed:", err);
      setError("Network error while updating booking.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={styles.wrapper}>
      <h2 style={styles.heading}>Scheduled Bookings</h2>
      {loading && <p style={{ textAlign: 'center' }}>Loading bookings...</p>}
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.cardList}>
        {bookings.map((b) => (
          <div key={b.scheduleName || b.id} style={styles.card}>
            {editingId === b.scheduleName ? (
              <>
                <input
                  value={editForm.first || ''}
                  onChange={e => setEditForm({ ...editForm, first: e.target.value })}
                  placeholder="First Name"
                  style={styles.input}
                />
                <input
                  value={editForm.last || ''}
                  onChange={e => setEditForm({ ...editForm, last: e.target.value })}
                  placeholder="Last Name"
                  style={styles.input}
                />
                <input
                  value={editForm.hut_number || ''}
                  onChange={e => setEditForm({ ...editForm, hut_number: e.target.value })}
                  placeholder="Hut Number"
                  style={styles.input}
                />
                <input
                  value={editForm.room || ''}
                  onChange={e => setEditForm({ ...editForm, room: e.target.value })}
                  placeholder="Room"
                  style={styles.input}
                />
                <input
                  value={editForm.email || ''}
                  onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                  placeholder="Email"
                  style={styles.input}
                />
                <input
                  value={editForm.phone || ''}
                  onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
                  placeholder="Phone"
                  style={styles.input}
                />

                <button onClick={saveEdit} style={styles.saveBtn} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={cancelEdit} style={styles.cancelBtn}>Cancel</button>
              </>
            ) : (
              <>
                <div><strong>Name:</strong> {b.name}</div>
                <div><strong>Hut:</strong> {b.hut_number}</div>
                <div><strong>Room:</strong> {b.room}</div>
                <div><strong>Email:</strong> {b.email}</div>
                <div><strong>Phone:</strong> {b.phone || '—'}</div>
                <div><strong>Time:</strong> {b.booking_time}</div>
                <div><strong>Status:</strong> {b.status || 'ENABLED'}</div>

                <button onClick={() => startEdit(b)} style={styles.editBtn}>Edit</button>
                <button
                  style={styles.deleteBtn}
                  onClick={() => handleDelete(b.scheduleName)}
                  disabled={deletingId === b.scheduleName}
                >
                  {deletingId === b.scheduleName ? 'Deleting...' : 'Delete'}
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  wrapper: {
    marginTop: '2rem',
    padding: '1.5rem',
    backgroundColor: '#fff',
    borderRadius: '8px',
    boxShadow: '0 2px 6px rgba(0,0,0,0.05)',
    maxWidth: '100%',
    width: '100%',
    boxSizing: 'border-box'
  },
  heading: {
    textAlign: 'center',
    marginBottom: '1rem',
    fontSize: '1.4rem',
    color: '#333'
  },
  cardList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem'
  },
  card: {
    padding: '1rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    backgroundColor: '#f8f8f8',
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem'
  },
  input: {
    padding: '0.5rem',
    fontSize: '1rem',
    border: '1px solid #ccc',
    borderRadius: '4px'
  },
  editBtn: {
    backgroundColor: '#007bff',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    padding: '0.4rem 0.7rem',
    cursor: 'pointer'
  },
  saveBtn: {
    backgroundColor: '#28a745',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    padding: '0.4rem 0.7rem',
    cursor: 'pointer'
  },
  cancelBtn: {
    backgroundColor: '#6c757d',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    padding: '0.4rem 0.7rem',
    cursor: 'pointer'
  },
  deleteBtn: {
    backgroundColor: '#dc3545',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    padding: '0.4rem 0.7rem',
    cursor: 'pointer'
  },
  error: {
    color: '#b00020',
    fontWeight: 'bold',
    textAlign: 'center',
    margin: '1rem 0'
  }
};
