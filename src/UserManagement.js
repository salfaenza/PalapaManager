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

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const fetchUsers = useCallback(async ({ clearStatus = true } = {}) => {
    setLoading(true);
    if (clearStatus) setStatus(null);
    try {
      const res = await fetch(`${API}/users`, { headers: authHeaders });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Failed to load users (${res.status})`);
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to fetch users', err);
      setStatus({ type: 'error', message: err.message || 'Could not load users.' });
      setUsers([]);
    } finally { setLoading(false); }
  }, [authHeaders]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...users].sort((a, b) => { if (a.role !== b.role) return a.role === 'admin' ? -1 : 1; return (a.email || '').localeCompare(b.email || ''); });
    if (!q) return sorted;
    return sorted.filter((u) => `${u.email || ''} ${u.role || ''}`.toLowerCase().includes(q));
  }, [users, query]);

  const counts = useMemo(() => ({
    total: users.length,
    admins: users.filter((u) => u.role === 'admin').length,
    users: users.filter((u) => u.role !== 'admin').length
  }), [users]);

  const handleChange = (e) => { setForm({ ...form, [e.target.name]: e.target.value }); setStatus(null); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    const email = form.email.trim().toLowerCase();
    if (!email) { setStatus({ type: 'error', message: 'Enter an email address.' }); return; }
    setSubmitting(true); setStatus(null);
    try {
      const res = await fetch(`${API}/users`, { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, role: form.role }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Failed to add user (${res.status})`);
      setStatus({ type: 'success', message: `${email} added as ${form.role}.` });
      setForm({ email: '', role: 'user' });
      await fetchUsers({ clearStatus: false });
    } catch (err) { setStatus({ type: 'error', message: err.message || 'Failed to add user.' }); }
    finally { setSubmitting(false); }
  };

  const handleDelete = async (email) => {
    if (!window.confirm(`Delete user ${email}?`)) return;
    setDeletingEmail(email); setStatus(null);
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(email)}`, { method: 'DELETE', headers: authHeaders });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Failed to delete user (${res.status})`);
      setStatus({ type: 'success', message: `${email} deleted.` });
      await fetchUsers({ clearStatus: false });
    } catch (err) { setStatus({ type: 'error', message: err.message || 'Failed to delete user.' }); }
    finally { setDeletingEmail(null); }
  };

  return (
    <div className="card users-page">
      <div className="users-header">
        <div>
          <h2 className="users-title">User Management</h2>
          <p className="users-subtitle">Control who can schedule bookings or manage the app.</p>
        </div>
        <button type="button" onClick={fetchUsers} className="btn btn-ghost btn-sm" disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="users-summary" aria-label="User counts">
        <SummaryItem label="Total" value={counts.total} />
        <SummaryItem label="Admins" value={counts.admins} />
        <SummaryItem label="Users" value={counts.users} />
      </div>

      <form onSubmit={handleSubmit} className="users-form">
        <div className="users-form-field">
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" name="email" placeholder="person@example.com" value={form.email} onChange={handleChange} required className="input" autoComplete="email" />
        </div>
        <div className="users-form-field">
          <label className="label" htmlFor="role">Role</label>
          <select id="role" name="role" value={form.role} onChange={handleChange} className="input">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button type="submit" className="btn btn-success" disabled={submitting || !form.email.trim()}>
          {submitting ? 'Adding...' : 'Add User'}
        </button>
      </form>

      {status && (
        <div role="status" className={status.type === 'error' ? 'msg-error' : 'msg-success'} style={{ marginTop: '0.75rem' }}>
          {status.message}
        </div>
      )}

      <div className="users-table-header">
        <h3 className="users-section-heading">Current Users</h3>
        <input type="search" placeholder="Search users" value={query} onChange={(e) => setQuery(e.target.value)} className="input users-search" aria-label="Search users" />
      </div>

      {loading ? (
        <p className="text-muted">Loading users...</p>
      ) : filteredUsers.length === 0 ? (
        <p className="text-muted">{query ? 'No users match your search.' : 'No users have been added yet.'}</p>
      ) : (
        <div className="users-table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user) => (
                <tr key={user.email}>
                  <td>{user.email}</td>
                  <td>
                    <span className={`badge ${user.role === 'admin' ? 'badge-admin' : 'badge-user'}`}>{user.role || 'user'}</span>
                  </td>
                  <td>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => handleDelete(user.email)} disabled={deletingEmail === user.email}>
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
    <div className="users-summary-item">
      <span className="users-summary-value">{value}</span>
      <span className="users-summary-label">{label}</span>
    </div>
  );
}
