import React, { useEffect, useState, useRef, useMemo } from 'react';

const AUTO_REFRESH_MS = 15000; // set to 0 to disable auto-refresh
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
  const timerRef = useRef(null);

  const loadLogs = async () => {
    try {
      const res = await fetch(`${API}/logs`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `Failed with status ${res.status}`);
      }

      if (!data.streams) {
        setStreams([]);
        setError('No logs found.');
      } else {
        const sorted = [...data.streams].sort(
          (a, b) => (b.lastEventTime || 0) - (a.lastEventTime || 0)
        );
        setStreams(sorted);
        setError('');
      }
    } catch (e) {
      console.error(e);
      setError(e.message || 'Failed to fetch logs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();

    if (AUTO_REFRESH_MS > 0) {
      timerRef.current = setInterval(loadLogs, AUTO_REFRESH_MS);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, API]);

  const filteredStreams = useMemo(() => {
    if (filter === FILTERS.ALL) return streams;

    return streams.filter((s) => {
      const success = checkSuccess(s.messages);
      return filter === FILTERS.SUCCESS ? success : !success;
    });
  }, [streams, filter]);

  if (loading) return <div style={styles.center}>Loading logs...</div>;
  if (error) return <div style={styles.error}>{error}</div>;

  const counts = {
    total: streams.length,
    success: streams.filter(s => checkSuccess(s.messages)).length,
    failed: streams.filter(s => !checkSuccess(s.messages)).length
  };

  return (
    <div style={styles.container}>
      <h2 style={styles.heading}>Execution Logs</h2>

      <FilterBar
        filter={filter}
        setFilter={setFilter}
        counts={counts}
      />

      {filteredStreams.length === 0 && (
        <div style={styles.center}>No logs found for this filter.</div>
      )}

      {filteredStreams.map((s, idx) => (
        <StreamCard key={s.streamName || idx} stream={s} />
      ))}
    </div>
  );
}

function FilterBar({ filter, setFilter, counts }) {
  return (
    <div style={styles.filterBar}>
      <button
        style={{
          ...styles.filterBtn,
          ...(filter === 'all' ? styles.filterBtnActive : {})
        }}
        onClick={() => setFilter('all')}
      >
        All ({counts.total})
      </button>
      <button
        style={{
          ...styles.filterBtn,
          ...(filter === 'success' ? styles.filterBtnActive : {})
        }}
        onClick={() => setFilter('success')}
      >
        ✅ Success ({counts.success})
      </button>
      <button
        style={{
          ...styles.filterBtn,
          ...(filter === 'failed' ? styles.filterBtnActive : {})
        }}
        onClick={() => setFilter('failed')}
      >
        ❌ Failed ({counts.failed})
      </button>
    </div>
  );
}

function StreamCard({ stream }) {
  const [expanded, setExpanded] = useState(false);

  const bookingInfo = findAndParseBookingInfo(stream.messages);
  const lastEvent = stream.lastEventTime
    ? new Date(stream.lastEventTime).toLocaleString()
    : 'N/A';

  const wasSuccessful = checkSuccess(stream.messages);

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader} onClick={() => setExpanded(!expanded)}>
        <div style={{ flex: 1 }}>
          <strong>
            {bookingInfo?.name || 'Unknown Booking'}{' '}
            {wasSuccessful
              ? <span style={styles.successIcon}>✅</span>
              : <span style={styles.failIcon}>❌</span>}
          </strong>
          <div style={styles.meta}>
            {bookingInfo
              ? (
                <>
                  Hut {bookingInfo.hut_number} • Room {bookingInfo.room} • {bookingInfo.booking_time}
                </>
              )
              : 'Could not parse booking header'}
          </div>
          <div style={styles.metaSmall}>
            {stream.streamName} • Last event: {lastEvent}
          </div>
        </div>
        <button style={styles.toggleBtn}>
          {expanded ? 'Hide' : 'View'}
        </button>
      </div>

      {expanded && (
        <div style={styles.logList}>
          {stream.messages.map((m, i) => (
            <pre key={i} style={styles.logLine}>{m}</pre>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Look through the stream's messages and try to find the first JSON-ish
 * line that looks like the payload you print at the start of execute-palapa-booking.
 */
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
  } catch (e) {
    return null;
  }
}

function checkSuccess(messages) {
  return messages.some(m =>
    m.includes('"success": "ok"') ||
    m.includes("'success': 'ok'")
  );
}

const styles = {
  container: {
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    maxWidth: '100%',
    boxSizing: 'border-box'
  },
  heading: {
    textAlign: 'center',
    fontSize: '1.5rem',
    fontWeight: '600',
    color: '#333'
  },
  filterBar: {
    display: 'flex',
    gap: '0.5rem',
    justifyContent: 'center',
    flexWrap: 'wrap'
  },
  filterBtn: {
    border: '1px solid #ccc',
    background: '#fff',
    borderRadius: '999px',
    padding: '0.35rem 0.8rem',
    cursor: 'pointer',
    fontSize: '0.85rem'
  },
  filterBtnActive: {
    background: '#007bff',
    color: '#fff',
    borderColor: '#007bff'
  },
  card: {
    background: '#fff',
    borderRadius: '10px',
    padding: '1rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    transition: 'all 0.2s ease-in-out'
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '0.75rem',
    cursor: 'pointer'
  },
  meta: {
    fontSize: '0.9rem',
    color: '#555',
    marginTop: '0.15rem'
  },
  metaSmall: {
    fontSize: '0.75rem',
    color: '#888',
    marginTop: '0.1rem'
  },
  toggleBtn: {
    background: '#007bff',
    color: '#fff',
    border: 'none',
    borderRadius: '5px',
    padding: '0.35rem 0.6rem',
    cursor: 'pointer',
    fontSize: '0.8rem'
  },
  logList: {
    marginTop: '0.5rem',
    background: '#1e1e1e',
    color: '#dcdcdc',
    padding: '0.5rem',
    borderRadius: '6px',
    maxHeight: '240px',
    overflowY: 'auto',
    fontFamily: 'monospace',
    fontSize: '0.85rem'
  },
  logLine: {
    margin: 0,
    whiteSpace: 'pre-wrap'
  },
  center: {
    textAlign: 'center',
    padding: '2rem'
  },
  error: {
    color: '#b00020',
    textAlign: 'center',
    fontWeight: 'bold'
  },
  successIcon: {
    color: '#28a745',
    marginLeft: '0.3rem'
  },
  failIcon: {
    color: '#dc3545',
    marginLeft: '0.3rem'
  }
};
