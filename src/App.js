import React, { useState, useEffect, useCallback } from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  Link,
  useLocation
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
      <NavBar userEmail={userEmail} userRole={userRole} handleLogout={handleLogout} />
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
        <Route
          path="/dashboard"
          element={
            <div style={styles.page}>
              <BookingsTable refreshTrigger={refreshKey} token={token} />
            </div>
          }
        />
        {userRole === 'admin' && (
          <Route
            path="/admin/users"
            element={
              <div style={styles.page}>
                <UserManagement token={token} />
              </div>
            }
          />
        )}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}

function NavBar({ userEmail, userRole, handleLogout }) {
  const location = useLocation();
  const isActive = (path) => location.pathname === path;

  return (
    <nav style={navStyles.bar}>
      <div style={navStyles.left}>
        <span style={navStyles.logo}>🏝 Palapa Booker</span>
        <Link to="/" style={isActive("/") ? navStyles.active : navStyles.link}>Home</Link>
        <Link to="/dashboard" style={isActive("/dashboard") ? navStyles.active : navStyles.link}>Dashboard</Link>
        {userRole === 'admin' && (
          <Link to="/admin/users" style={isActive("/admin/users") ? navStyles.active : navStyles.link}>Users</Link>
        )}
      </div>
      <div style={navStyles.right}>
        <span>{userEmail}</span>
        <button onClick={handleLogout} style={navStyles.logout}>Logout</button>
      </div>
    </nav>
  );
}

const styles = {
  page: {
    padding: '2rem',
    backgroundColor: '#f9f9f9',
    minHeight: '100vh',
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

const navStyles = {
  bar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1rem 2rem',
    backgroundColor: '#007bff',
    color: '#fff',
    position: 'sticky',
    top: 0,
    zIndex: 999
  },
  left: {
    display: 'flex',
    gap: '1.5rem',
    alignItems: 'center'
  },
  logo: {
    fontWeight: 'bold',
    fontSize: '1.2rem'
  },
  link: {
    color: '#fff',
    textDecoration: 'none',
    fontSize: '1rem',
    opacity: 0.85
  },
  active: {
    color: '#fff',
    textDecoration: 'underline',
    fontWeight: 'bold'
  },
  right: {
    display: 'flex',
    gap: '1rem',
    alignItems: 'center'
  },
  logout: {
    backgroundColor: '#dc3545',
    color: '#fff',
    border: 'none',
    padding: '0.5rem 0.75rem',
    borderRadius: '4px',
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
