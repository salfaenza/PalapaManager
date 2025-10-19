import React, { useState, useEffect, useCallback } from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  useLocation,
  Link
} from 'react-router-dom';
import { GoogleOAuthProvider, GoogleLogin, googleLogout } from '@react-oauth/google';
import jwtDecode from 'jwt-decode';
import BookingForm from './BookingForm';
import BookingsTable from './BookingsTable';
import UserManagement from './UserManagement';
import LogsPage from './LogsPage';
import './App.css';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

function App() {
  const [userEmail, setUserEmail] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleLogout = useCallback(() => {
    googleLogout();
    setUserEmail(null);
    setUserRole(null);
    setToken(null);
    localStorage.clear();
    setLoading(false); // ensure spinner is cleared on any logout path
  }, []);

  const validateUser = useCallback(
    async (idToken) => {
      try {
        const decoded = jwtDecode(idToken);
        const now = Math.floor(Date.now() / 1000);
        // allow a little skew so just-issued tokens don't get rejected
        if (decoded?.exp && decoded.exp <= now - 60) {
          throw new Error('Token expired');
        }

        const res = await fetch(`${API}/auth-check`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) throw new Error(`Unauthorized: ${res.status}`);

        const data = await res.json();
        setUserEmail(data.email);
        setUserRole(data.role);
        return true;
      } catch (err) {
        console.error('validateUser failed:', err);
        handleLogout();
        return false;
      } finally {
        // CRITICAL: always release the spinner, success or error
        setLoading(false);
      }
    },
    [handleLogout]
  );

  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    const storedEmail = localStorage.getItem('userEmail');

    if (storedToken) {
      setLoading(true);
      setToken(storedToken);
      if (storedEmail) setUserEmail(storedEmail);
      validateUser(storedToken);
    } else {
      setLoading(false);
    }
  }, [validateUser]);

  const handleLogin = (credentialResponse) => {
    try {
      const idToken = credentialResponse?.credential;
      if (!idToken) throw new Error('No credential returned from Google');
      setLoading(true);

      const decoded = jwtDecode(idToken);
      localStorage.setItem('userEmail', decoded.email);
      localStorage.setItem('token', idToken);

      setToken(idToken);
      setUserEmail(decoded.email);

      validateUser(idToken);
    } catch (err) {
      console.error('handleLogin failed:', err);
      setLoading(false);
      alert('Login failed. Please try again.');
    }
  };

  const triggerRefresh = (delay = 1000) => {
    setTimeout(() => setRefreshKey((prev) => prev + 1), delay);
  };

  if (loading) {
    return (
      <div className="centered">
        <div className="spinner" />
        <p>Loading...</p>
      </div>
    );
  }

  if (!userEmail || !userRole) {
    return (
      <div className="centered">
        <h2>Sign In</h2>
        <GoogleLogin
          onSuccess={handleLogin}
          onError={() => {
            setLoading(false);
            alert('Login Failed');
          }}
          useOneTap
        />
      </div>
    );
  }

  return (
    <Router>
      <Routes>
        <Route
          path="/"
          element={
            <div className="page">
              <BookingForm triggerRefresh={triggerRefresh} token={token} />
              <BookingsTable refreshTrigger={refreshKey} token={token} />
            </div>
          }
        />

        {userRole === 'admin' && (
          <>
            <Route
              path="/admin/users"
              element={
                <div className="page">
                  <UserManagement token={token} />
                </div>
              }
            />
            <Route
              path="/admin/logs"
              element={
                <div className="page">
                  <LogsPage token={token} />
                </div>
              }
            />
          </>
        )}

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>

      <BottomNav userRole={userRole} handleLogout={handleLogout} />
    </Router>
  );
}

function BottomNav({ userRole, handleLogout }) {
  const location = useLocation();
  const isActive = (path) => location.pathname === path;

  return (
    <nav className="bottom-nav-bar">
      <Link
        to="/"
        className={isActive('/') ? 'bottom-nav-link active' : 'bottom-nav-link'}
      >
        Book
      </Link>

      {userRole === 'admin' && (
        <>
          <Link
            to="/admin/users"
            className={
              isActive('/admin/users') ? 'bottom-nav-link active' : 'bottom-nav-link'
            }
          >
            Users
          </Link>
          <Link
            to="/admin/logs"
            className={
              isActive('/admin/logs') ? 'bottom-nav-link active' : 'bottom-nav-link'
            }
          >
            Logs
          </Link>
        </>
      )}

      <button onClick={handleLogout} className="bottom-nav-logout">
        Logout
      </button>
    </nav>
  );
}

export default function WrappedApp() {
  return (
    <GoogleOAuthProvider clientId={process.env.REACT_APP_GOOGLE_CLIENT_ID}>
      <App />
    </GoogleOAuthProvider>
  );
}
