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
import { jwtDecode } from 'jwt-decode'; // Correct for v4+
import BookingForm from './BookingForm';
import BookingsTable from './BookingsTable';
import UserManagement from './UserManagement';
import './App.css';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

function App() {
  const [userEmail, setUserEmail] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleLogout = useCallback(() => {
    console.log("Logging out...");
    googleLogout();
    setUserEmail(null);
    setUserRole(null);
    setToken(null);
    localStorage.clear();
  }, []);

  const validateUser = useCallback(async (token) => {
    try {
      console.log("Validating token:", token);
      const decoded = jwtDecode(token);
      console.log("Decoded JWT:", decoded);

      if (decoded.exp < Date.now() / 1000 - 10) {
        console.warn("Token expired:", decoded.exp);
        throw new Error("Token expired");
      }

      const res = await fetch(`${API}/auth-check`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      console.log("Auth-check status:", res.status);
      if (!res.ok) throw new Error(`Unauthorized: ${res.status}`);

      const data = await res.json();
      console.log("Auth-check response:", data);

      setUserEmail(data.email);
      setUserRole(data.role);
      setLoading(false);
    } catch (err) {
      console.error("Access denied:", err.message);
      handleLogout();
    }
  }, [handleLogout]);

  useEffect(() => {
    const storedToken = localStorage.getItem("token");
    const storedEmail = localStorage.getItem("userEmail");

    if (storedToken) {
      console.log("Found stored token:", storedToken);
      setToken(storedToken);
      if (storedEmail) setUserEmail(storedEmail);
      validateUser(storedToken);
    } else {
      console.log("No stored token found");
      setLoading(false);
    }
  }, [validateUser]);

  const handleLogin = (credentialResponse) => {
    console.log("Google login response:", credentialResponse);

    try {
      const decoded = jwtDecode(credentialResponse.credential);
      console.log("Decoded Google JWT:", decoded);

      localStorage.setItem("userEmail", decoded.email);
      localStorage.setItem("token", credentialResponse.credential);
      setToken(credentialResponse.credential);
      setUserEmail(decoded.email);
      validateUser(credentialResponse.credential);
    } catch (err) {
      console.error("Login error:", err);
      alert("Login failed. Check console logs for details.");
    }
  };

  const triggerRefresh = (delay = 1000) => {
    setTimeout(() => setRefreshKey(prev => prev + 1), delay);
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
          onError={() => alert("Login Failed")}
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
        <Route
          path="/admin/users"
          element={
            userRole === 'admin'
              ? <div className="page"><UserManagement token={token} /></div>
              : <Navigate to="/" />
          }
        />
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
      <Link to="/" className={isActive("/") ? "bottom-nav-link active" : "bottom-nav-link"}>Book</Link>
      {userRole === 'admin' && (
        <Link to="/admin/users" className={isActive("/admin/users") ? "bottom-nav-link active" : "bottom-nav-link"}>Users</Link>
      )}
      <button onClick={handleLogout} className="bottom-nav-logout">Logout</button>
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
