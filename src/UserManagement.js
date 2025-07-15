import React, { useState, useEffect, useCallback } from 'react';

export default function UserManagement({ token }) {
  const [form, setForm] = useState({ email: '', role: 'user' });
  const [status, setStatus] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to fetch users", err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
    setStatus(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(form)
      });

      if (res.ok) {
        setStatus({ type: 'success', message: `User ${form.email} added.` });
        setForm({ email: '', role: 'user' });
        fetchUsers();
      } else {
        const err = await res.json();
        setStatus({ type: 'error', message: err.error || "Failed to add user" });
      }
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  };

  const handleDelete = async (email) => {
    if (!window.confirm(`Delete user ${email}?`)) return;
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/users/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (res.ok) {
        fetchUsers();
      } else {
        alert("Failed to delete user");
      }
    } catch (err) {
      console.error("Delete failed", err);
    }
  };

  return (
    <div style={styles.page}>
      <h2 style={styles.heading}>User Management</h2>
      <form onSubmit={handleSubmit} style={styles.form}>
        <input
          type="email"
          name="email"
          placeholder="User Email"
          value={form.email}
          onChange={handleChange}
          required
          style={styles.input}
        />
        <select name="role" value={form.role} onChange={handleChange} style={styles.input}>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" style={styles.button}>Add User</button>
        {status && (
          <div style={status.type === 'error' ? styles.error : styles.success}>
            {status.message}
          </div>
        )}
      </form>

      <h3 style={{ marginTop: '2rem' }}>Current Users</h3>
      {loading ? <p>Loading...</p> : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.cell}>Email</th>
              <th style={styles.cell}>Role</th>
              <th style={styles.cell}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user, i) => (
              <tr key={i}>
                <td style={styles.cell}>{user.email}</td>
                <td style={styles.cell}>{user.role}</td>
                <td style={styles.cell}>
                  <button style={styles.deleteBtn} onClick={() => handleDelete(user.email)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const styles = {
  page: {
    maxWidth: '600px',
    margin: '2rem auto',
    padding: '2rem',
    background: '#fff',
    borderRadius: '8px',
    boxShadow: '0 0 10px rgba(0,0,0,0.05)',
  },
  heading: {
    textAlign: 'center',
    marginBottom: '1rem'
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem'
  },
  input: {
    padding: '0.75rem',
    fontSize: '1rem',
    borderRadius: '4px',
    border: '1px solid #ccc'
  },
  button: {
    padding: '0.75rem',
    backgroundColor: '#28a745',
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
  },
  table: {
    width: '100%',
    marginTop: '1rem',
    borderCollapse: 'collapse',
    fontSize: '0.95rem'
  },
  cell: {
    padding: '0.75rem',
    borderBottom: '1px solid #eee'
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
