import React, { useEffect, useState, useMemo, useCallback } from 'react';

const FILTERS = {
  ALL: 'all',
  SUCCESS: 'success',
  FAILED: 'failed'
};

export default function LogsPage({ token }) {
  const [streams, setStreams] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState(FILTERS.ALL);
  const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

  const loadLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/logs`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed with status ${res.status}`);

      const sorted = [...(data.streams || [])].sort(
        (a, b) => (b.lastEventTime || 0) - (a.lastEventTime || 0)
      );
      setStreams(sorted);
      setError('');
    } catch (e) {
      console.error(e);
      setError(e.message || 'Failed to fetch logs');
    } finally {
      setLoading(false);
    }
  }, [API, token]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const filteredStreams = useMemo(() => {
    if (filter === FILTERS.ALL) return streams;
    return streams.filter((s) =>
      filter === FILTERS.SUCCESS
        ? checkSuccess(s.messages)
        : !checkSuccess(s.messages)
    );
  }, [streams, filter]);

  if (loading) return <div className="centered">Loading logs...</div>;
  if (error) return <div className="logs-error">{error}</div>;

  const counts = {
    total: streams.length,
    success: streams.filter(s => checkSuccess(s.messages)).length,
    failed: streams.filter(s => !checkSuccess(s.messages)).length
  };

  return (
    <div className="logs-container">
      <h2 className="logs-heading">Execution Logs</h2>
      <FilterBar filter={filter} setFilter={setFilter} counts={counts} />
      {filteredStreams.length === 0 && <div className="centered">No logs found for this filter.</div>}
      {filteredStreams.map((s, idx) => (
        <StreamCard key={s.streamName || idx} stream={s} token={token} API={API} />
      ))}
    </div>
  );
}

function FilterBar({ filter, setFilter, counts }) {
  return (
    <div className="logs-filter-bar">
      <button className={`logs-filter-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
        All ({counts.total})
      </button>
      <button className={`logs-filter-btn ${filter === 'success' ? 'active' : ''}`} onClick={() => setFilter('success')}>
        ✅ Success ({counts.success})
      </button>
      <button className={`logs-filter-btn ${filter === 'failed' ? 'active' : ''}`} onClick={() => setFilter('failed')}>
        ❌ Failed ({counts.failed})
      </button>
    </div>
  );
}

function StreamCard({ stream, token, API }) {
  const [expanded, setExpanded] = useState(false);
  const [fullMessages, setFullMessages] = useState(null);
  const [loading, setLoading] = useState(false);

  const bookingInfo = findAndParseBookingInfo(stream.messages);
  const lastEvent = stream.lastEventTime
    ? new Date(stream.lastEventTime).toLocaleString()
    : 'N/A';
  const wasSuccessful = checkSuccess(stream.messages);

  const handleToggle = async () => {
    if (!expanded && !fullMessages) {
      try {
        setLoading(true);
        const res = await fetch(`${API}/logs/${encodeURIComponent(stream.streamName)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok && data.messages) {
          setFullMessages(data.messages);
        } else {
          setFullMessages(["Failed to load full log"]);
        }
      } catch (e) {
        console.error("Error loading full log", e);
        setFullMessages(["Error fetching full log"]);
      } finally {
        setLoading(false);
      }
    }
    setExpanded(!expanded);
  };

  return (
    <div className="log-card">
      <div className="log-card-header" onClick={handleToggle}>
        <div style={{ flex: 1 }}>
          <strong>
            {bookingInfo?.name || 'Unknown Booking'}{' '}
            {wasSuccessful ? <span className="log-success">✅</span> : <span className="log-fail">❌</span>}
          </strong>
          <div className="log-meta">
            {bookingInfo
              ? <>Hut {bookingInfo.hut_number} • Room {bookingInfo.room} • {bookingInfo.booking_time}</>
              : 'Could not parse booking header'}
          </div>
          <div className="log-meta-small">
            {stream.streamName} • Last event: {lastEvent}
          </div>
        </div>
        <button className="log-toggle-btn">{expanded ? 'Hide' : 'View'}</button>
      </div>

      {expanded && (
        <div className="log-list">
          {loading && <div className="log-line">Loading full log...</div>}
          {(fullMessages || stream.messages).map((m, i) => (
            <pre key={i} className="log-line">{m}</pre>
          ))}
        </div>
      )}
    </div>
  );
}

/** Helpers **/

function findAndParseBookingInfo(messages = []) {
  for (const msg of messages) {
    if (msg.includes("'id':") || msg.trim().startsWith('{')) {
      const parsed = parsePythonishJson(msg);
      if (parsed && (parsed.name || parsed.hut_number || parsed.room)) {
        return parsed;
      }
    }
  }
  return null;
}

function parsePythonishJson(raw) {
  try {
    const start = raw.indexOf('{');
    if (start === -1) return null;
    const jsonCandidate = raw.slice(start);
    const normalized = jsonCandidate
      .replace(/'/g, '"')
      .replace(/\bNone\b/g, 'null')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false');
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function checkSuccess(messages) {
  return messages.some(m =>
    m.includes('"success": "ok"') || m.includes("'success': 'ok'")
  );
}
