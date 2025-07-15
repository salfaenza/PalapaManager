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
import { jwtDecode } from 'jwt-decode';
import BookingForm from './BookingForm';
import BookingsTable from './BookingsTable';
import UserManagement from './UserManagement';

function App() {
  const [userEmail, setUserEmail] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleLogout = () => {
    googleLogout();
    setUserEmail(null);
    setUserRole(null);
    setToken(null);
    localStorage.clear();
  };

  const validateUser = useCallback(async (token) => {
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/auth-check`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Unauthorized");

      const data = await res.json();
      setUserEmail(data.email);
      setUserRole(data.role);
      setLoading(false);
    } catch (err) {
      console.error("Access denied:", err.message);
      handleLogout();
    }
  }, []);

  useEffect(() => {
    const storedToken = localStorage.getItem("token");
    if (storedToken) {
      setToken(storedToken);
      validateUser(storedToken);
    } else {
      setLoading(false);
    }
  }, [validateUser]);

  const handleLogin = (credentialResponse) => {
    const decoded = jwtDecode(credentialResponse.credential);
    localStorage.setItem("userEmail", decoded.email);
    localStorage.setItem("token", credentialResponse.credential);
    setToken(credentialResponse.credential);
    validateUser(credentialResponse.credential);
  };

  const triggerRefresh = () => {
    setTimeout(() => setRefreshKey(prev => prev + 1), 5000);
    setTimeout(() => setRefreshKey(prev => prev + 1), 10000);
  };

  if (loading) {
    return <div style={styles.centered}>Loading...</div>;
  }

  if (!userEmail || !userRole) {
    return (
      <div style={styles.centered}>
        <h2>Sign In</h2>
        <GoogleLogin onSuccess={handleLogin} onError={() => alert("Login Failed")} />
      </div>
    );
  }

  return (
    <Router>
      <Routes>
        <Route
          path="/"
          element={
            <div style={styles.page}>
              <BookingForm triggerRefresh={triggerRefresh} token={token} />
              <BookingsTable refreshTrigger={refreshKey} token={token} />
            </div>
          }
        />
        {userRole === 'admin' && (
          <Route
            path="/admin/users"
            element={<div style={styles.page}><UserManagement token={token} /></div>}
          />
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
    <nav style={bottomNav.bar}>
      <Link to="/" style={isActive("/") ? bottomNav.active : bottomNav.link}>Book</Link>
      {userRole === 'admin' && (
        <Link to="/admin/users" style={isActive("/admin/users") ? bottomNav.active : bottomNav.link}>Users</Link>
      )}
      <button onClick={handleLogout} style={bottomNav.logout}>Logout</button>
    </nav>
  );
}

const styles = {
  page: {
    padding: '1rem',
    backgroundColor: '#f9f9f9',
    minHeight: '100vh',
    paddingBottom: '4rem'
  },
  centered: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    gap: '1rem',
  }
};

const bottomNav = {
  bar: {
    display: 'flex',
    justifyContent: 'space-around',
    position: 'fixed',
    bottom: 0,
    left: 0,
    width: '100%',
    backgroundColor: '#007bff',
    padding: '0.75rem 1rem',
    borderTop: '1px solid #ccc',
    zIndex: 1000
  },
  link: {
    color: '#fff',
    fontSize: '1rem',
    textDecoration: 'none',
    opacity: 0.85
  },
  active: {
    color: '#fff',
    textDecoration: 'underline',
    fontWeight: 'bold'
  },
  logout: {
    backgroundColor: 'transparent',
    color: '#fff',
    border: 'none',
    fontSize: '1rem',
    cursor: 'pointer'
  }
};

export default function WrappedApp() {
  return (
    <GoogleOAuthProvider clientId={process.env.REACT_APP_GOOGLE_CLIENT_ID}>
      <App />
    </GoogleOAuthProvider>
  );
}
