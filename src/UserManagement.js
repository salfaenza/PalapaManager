import React, { useState, useEffect, useCallback, useMemo } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

export default function UserManagement({ token }) {
  const [form, setForm] = useState({ email: '', role: 'user' });
  const [status, setStatus] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deletingEmail, setDeletingEmail] = useState(null);
  const [query, setQuery] = useState('');

  const fetchUsers = useCallback(async ({ clearStatus = true } = {}) => {
    setLoading(true);
    if (clearStatus) setStatus(null);
    try {
      const res = await fetch(`${API}/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || `Failed to load users (${res.status})`);
      }
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to fetch users', err);
      setStatus({ type: 'error', message: err.message || 'Could not load users.' });
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const filteredUsers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const sorted = [...users].sort((a, b) => {
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
      return (a.email || '').localeCompare(b.email || '');
    });

    if (!normalizedQuery) return sorted;
    return sorted.filter((user) =>
      `${user.email || ''} ${user.role || ''}`.toLowerCase().includes(normalizedQuery)
    );
  }, [users, query]);

  const counts = useMemo(() => ({
    total: users.length,
    admins: users.filter((user) => user.role === 'admin').length,
    users: users.filter((user) => user.role !== 'admin').length
  }), [users]);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
    setStatus(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    const email = form.email.trim().toLowerCase();
    if (!email) {
      setStatus({ type: 'error', message: 'Enter an email address.' });
      return;
    }

    setSubmitting(true);
    setStatus(null);

    try {
      const res = await fetch(`${API}/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ email, role: form.role })
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(data?.error || `Failed to add user (${res.status})`);
      }

      setStatus({ type: 'success', message: `${email} added as ${form.role}.` });
      setForm({ email: '', role: 'user' });
      await fetchUsers({ clearStatus: false });
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to add user.' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (email) => {
    if (!window.confirm(`Delete user ${email}?`)) return;

    setDeletingEmail(email);
    setStatus(null);

    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(data?.error || `Failed to delete user (${res.status})`);
      }

      setStatus({ type: 'success', message: `${email} deleted.` });
      await fetchUsers({ clearStatus: false });
    } catch (err) {
      console.error('Delete failed', err);
      setStatus({ type: 'error', message: err.message || 'Failed to delete user.' });
    } finally {
      setDeletingEmail(null);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.heading}>User Management</h2>
          <p style={styles.subheading}>Control who can schedule bookings or manage the app.</p>
        </div>
        <button type="button" onClick={fetchUsers} style={styles.secondaryButton} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div style={styles.summaryRow} aria-label="User counts">
        <SummaryItem label="Total" value={counts.total} />
        <SummaryItem label="Admins" value={counts.admins} />
        <SummaryItem label="Users" value={counts.users} />
      </div>

      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.formField}>
          <label style={styles.label} htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            name="email"
            placeholder="person@example.com"
            value={form.email}
            onChange={handleChange}
            required
            style={styles.input}
            autoComplete="email"
          />
        </div>

        <div style={styles.formField}>
          <label style={styles.label} htmlFor="role">Role</label>
          <select id="role" name="role" value={form.role} onChange={handleChange} style={styles.input}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        <button type="submit" style={styles.button} disabled={submitting || !form.email.trim()}>
          {submitting ? 'Adding...' : 'Add User'}
        </button>
      </form>

      {status && (
        <div role="status" style={status.type === 'error' ? styles.error : styles.success}>
          {status.message}
        </div>
      )}

      <div style={styles.tableHeader}>
        <h3 style={styles.sectionHeading}>Current Users</h3>
        <input
          type="search"
          placeholder="Search users"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={styles.search}
          aria-label="Search users"
        />
      </div>

      {loading ? (
        <p style={styles.muted}>Loading users...</p>
      ) : filteredUsers.length === 0 ? (
        <p style={styles.muted}>{query ? 'No users match your search.' : 'No users have been added yet.'}</p>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.headerCell}>Email</th>
                <th style={styles.headerCell}>Role</th>
                <th style={styles.headerCell}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user) => (
                <tr key={user.email}>
                  <td style={styles.cell}>{user.email}</td>
                  <td style={styles.cell}>
                    <span style={user.role === 'admin' ? styles.adminBadge : styles.userBadge}>
                      {user.role || 'user'}
                    </span>
                  </td>
                  <td style={styles.cell}>
                    <button
                      type="button"
                      style={styles.deleteBtn}
                      onClick={() => handleDelete(user.email)}
                      disabled={deletingEmail === user.email}
                    >
                      {deletingEmail === user.email ? 'Deleting...' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryItem({ label, value }) {
  return (
    <div style={styles.summaryItem}>
      <span style={styles.summaryValue}>{value}</span>
      <span style={styles.summaryLabel}>{label}</span>
    </div>
  );
}

const styles = {
  page: {
    maxWidth: '820px',
    margin: '2rem auto',
    padding: '1.25rem',
    background: '#fff',
    borderRadius: '8px',
    boxShadow: '0 0 10px rgba(0,0,0,0.05)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '1rem',
    alignItems: 'flex-start',
    flexWrap: 'wrap'
  },
  heading: {
    margin: 0,
    marginBottom: '0.25rem'
  },
  subheading: {
    margin: 0,
    color: '#5d6778'
  },
  summaryRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
    gap: '0.75rem',
    margin: '1.25rem 0'
  },
  summaryItem: {
    border: '1px solid #e1e5ea',
    borderRadius: '8px',
    padding: '0.8rem',
    background: '#f7fafc'
  },
  summaryValue: {
    display: 'block',
    fontSize: '1.4rem',
    fontWeight: '700',
    color: '#1f2937'
  },
  summaryLabel: {
    display: 'block',
    color: '#5d6778',
    marginTop: '0.15rem'
  },
  form: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '0.75rem',
    alignItems: 'end'
  },
  formField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem'
  },
  label: {
    fontWeight: '700',
    color: '#3f4856'
  },
  input: {
    minHeight: '42px',
    padding: '0.65rem',
    fontSize: '1rem',
    borderRadius: '6px',
    border: '1px solid #c8ced8',
    boxSizing: 'border-box',
    width: '100%'
  },
  button: {
    minHeight: '42px',
    padding: '0.65rem 1rem',
    backgroundColor: '#267a3f',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: '700'
  },
  secondaryButton: {
    padding: '0.55rem 0.8rem',
    backgroundColor: '#ffffff',
    color: '#1f2937',
    border: '1px solid #c8ced8',
    borderRadius: '6px',
    cursor: 'pointer'
  },
  error: {
    marginTop: '1rem',
    padding: '0.75rem',
    borderRadius: '6px',
    background: '#fff0f2',
    color: '#9f1239',
    fontWeight: '700'
  },
  success: {
    marginTop: '1rem',
    padding: '0.75rem',
    borderRadius: '6px',
    background: '#edf9f0',
    color: '#126b2f',
    fontWeight: '700'
  },
  tableHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
    marginTop: '1.75rem',
    flexWrap: 'wrap'
  },
  sectionHeading: {
    margin: 0
  },
  search: {
    minHeight: '40px',
    padding: '0.55rem 0.65rem',
    fontSize: '1rem',
    borderRadius: '6px',
    border: '1px solid #c8ced8',
    minWidth: '220px'
  },
  tableWrap: {
    overflowX: 'auto',
    marginTop: '0.75rem'
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.95rem'
  },
  headerCell: {
    padding: '0.75rem',
    borderBottom: '1px solid #d9dee7',
    textAlign: 'left',
    color: '#5d6778',
    fontWeight: '700'
  },
  cell: {
    padding: '0.75rem',
    borderBottom: '1px solid #edf0f4',
    textAlign: 'left'
  },
  adminBadge: {
    display: 'inline-block',
    padding: '0.2rem 0.5rem',
    borderRadius: '6px',
    background: '#e8f0fe',
    color: '#174ea6',
    fontWeight: '700',
    textTransform: 'capitalize'
  },
  userBadge: {
    display: 'inline-block',
    padding: '0.2rem 0.5rem',
    borderRadius: '6px',
    background: '#eef6f3',
    color: '#116149',
    fontWeight: '700',
    textTransform: 'capitalize'
  },
  deleteBtn: {
    backgroundColor: '#c7374a',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    padding: '0.45rem 0.7rem',
    cursor: 'pointer'
  },
  muted: {
    color: '#5d6778',
    marginTop: '1rem'
  }
};
