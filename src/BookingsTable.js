import React, { useEffect, useState, useCallback } from 'react';

export default function BookingsTable({ token, refreshTrigger }) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchBookings = useCallback(() => {
    fetch(`${process.env.REACT_APP_API_URL}/bookings`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
      .then(res => res.json())
      .then(setBookings)
      .catch(err => {
        console.error("Failed to fetch bookings", err);
      });
  }, [token]);

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings]);

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings, refreshTrigger]);

  const handleDelete = async (scheduleName) => {
    if (!window.confirm(`Delete schedule "${scheduleName}"?`)) return;
    setLoading(true);

    const res = await fetch(`${process.env.REACT_APP_API_URL}/bookings/${encodeURIComponent(scheduleName)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (res.ok) {
      fetchBookings();
    } else {
      alert("Failed to delete schedule");
    }

    setLoading(false);
  };

  return (
    <div style={styles.wrapper}>
      <h2 style={styles.heading}>Scheduled Bookings</h2>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.cell}>Name</th>
            <th style={styles.cell}>Hut</th>
            <th style={styles.cell}>Room</th>
            <th style={styles.cell}>Email</th>
            <th style={styles.cell}>Time</th>
            <th style={styles.cell}>Status</th>
            <th style={styles.cell}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {bookings.map((b, i) => (
            <tr key={i}>
              <td style={styles.cell}>{b.name}</td>
              <td style={styles.cell}>{b.hut_number}</td>
              <td style={styles.cell}>{b.room}</td>
              <td style={styles.cell}>{b.email}</td>
              <td style={styles.cell}>{b.booking_time}</td>
              <td style={styles.cell}>{b.status || 'ENABLED'}</td>
              <td style={styles.cell}>
                <button
                  style={styles.deleteBtn}
                  onClick={() => handleDelete(b.scheduleName || b.name)}
                  disabled={loading}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
    maxWidth: '1000px',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  heading: {
    textAlign: 'center',
    marginBottom: '1rem',
    fontSize: '1.4rem',
    color: '#333'
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.95rem'
  },
  cell: {
    padding: '0.75rem',
    textAlign: 'left',
    borderBottom: '1px solid #eee',
    verticalAlign: 'middle'
  },
  deleteBtn: {
    backgroundColor: '#dc3545',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    padding: '0.4rem 0.7rem',
    cursor: 'pointer'
  }
};
