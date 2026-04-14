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
        <StreamCard key={`${s.logGroup || 'standard'}:${s.streamName || idx}`} stream={s} token={token} API={API} />
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
        Success ({counts.success})
      </button>
      <button className={`logs-filter-btn ${filter === 'failed' ? 'active' : ''}`} onClick={() => setFilter('failed')}>
        Failed ({counts.failed})
      </button>
    </div>
  );
}

function StreamCard({ stream, token, API }) {
  const [expanded, setExpanded] = useState(false);
  const [fullMessages, setFullMessages] = useState(null);
  const [loading, setLoading] = useState(false);

  const visibleMessages = fullMessages || stream.messages;
  const debugEvents = parseDebugEvents(visibleMessages);
  const runSummary = summarizeRun(debugEvents, visibleMessages);
  const bookingInfo = findAndParseBookingInfo(visibleMessages);
  const lastEvent = stream.lastEventTime
    ? new Date(stream.lastEventTime).toLocaleString()
    : 'N/A';
  const wasSuccessful = checkSuccess(visibleMessages);

  const handleToggle = async () => {
    if (!expanded && !fullMessages) {
      try {
        setLoading(true);
        const params = stream.logGroup ? `?logGroup=${encodeURIComponent(stream.logGroup)}` : '';
        const res = await fetch(`${API}/logs/${encodeURIComponent(stream.streamName)}${params}`, {
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
            {wasSuccessful ? <span className="log-success">Success</span> : <span className="log-fail">Failed</span>}
            <span className={`log-mode-badge ${stream.functionMode === 'debug' ? 'log-debug' : 'log-standard'}`}>
              {stream.functionMode === 'debug' ? 'Debug' : 'Standard'}
            </span>
          </strong>
          <div className="log-meta">
            {bookingInfo
              ? <>Hut {bookingInfo.hut_number} • Room {bookingInfo.room} • {bookingInfo.booking_time}</>
              : 'Could not parse booking header'}
          </div>
          {runSummary.reason && <div className="log-meta">{runSummary.reason}</div>}
          <div className="log-meta-small">
            {stream.streamName} • {stream.logGroup || '/aws/lambda/execute-palapa-booking'} • Last event: {lastEvent}
          </div>
        </div>
        <button className="log-toggle-btn">{expanded ? 'Hide' : 'View'}</button>
      </div>

      {expanded && (
        <>
          {runSummary.steps.length > 0 && (
            <div className="log-summary">
              {runSummary.steps.map((step) => (
                <div key={step.label} className="log-step">
                  <span className={`log-step-dot ${step.status}`}></span>
                  <div>
                    <strong>{step.label}</strong>
                    <div className="log-meta-small">{step.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="log-list">
            {loading && <div className="log-line">Loading full log...</div>}
            {visibleMessages.map((m, i) => (
              <pre key={i} className="log-line">{m}</pre>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Helpers **/

function findAndParseBookingInfo(messages = []) {
  for (const msg of messages) {
    if (
      msg.includes("'id':")
      || msg.includes('"id":')
      || msg.includes('PALAPA_DEBUG')
      || msg.includes('DEBUG_LAMBDA_EVENT')
      || msg.trim().startsWith('{')
    ) {
      const parsed = parsePythonishJson(msg);
      if (parsed && (parsed.name || parsed.hut_number || parsed.room)) {
        return parsed;
      }
      if (parsed?.event && (parsed.event.name || parsed.event.hut_number || parsed.event.room)) {
        return parsed.event;
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
  const events = parseDebugEvents(messages);
  return events.some(e =>
    e.name === 'lambda_complete' || (e.name === 'book_from_cart_result' && e.success === 'ok')
  ) || messages.some(m =>
    m.includes('"success": "ok"') || m.includes("'success': 'ok'")
  );
}

function parseDebugEvents(messages = []) {
  return messages
    .map(parsePythonishJson)
    .filter((event) => event && event.debug && event.name);
}

function findEvent(events, names) {
  const wanted = Array.isArray(names) ? names : [names];
  return events.find((event) => wanted.includes(event.name));
}

function summarizeRun(events, messages) {
  const steps = [];
  const addStep = (label, event, detail, status = 'pending') => {
    if (!event && !detail) return;
    steps.push({ label, detail: detail || event?.utc || '', status });
  };

  const started = findEvent(events, 'lambda_start');
  const timing = findEvent(events, 'prefire_timing');
  const target = findEvent(events, 'target_booking_selected');
  const reserveSuccess = events.find((event) => event.name === 'reserve_attempt' && event.success === 'ok');
  const reserveFailure = findEvent(events, ['reserve_exhausted', 'lambda_exit_no_reserve']);
  const cartSuccess = events.find((event) => event.name === 'add_to_cart_shot' && event.success === 'ok');
  const cartFailure = findEvent(events, ['add_to_cart_exhausted', 'lambda_exit_no_cart']);
  const checkout = findEvent(events, 'book_from_cart_result');
  const complete = findEvent(events, 'lambda_complete');
  const tooEarly = findEvent(events, 'lambda_exit_too_early');
  const exception = findEvent(events, 'lambda_exception');

  addStep('Started', started, started?.local_now || started?.utc, 'ok');
  addStep(
    'Timing',
    timing,
    timing ? `${timing.seconds_until_prefire}s until prefire, opens ${timing.booking_start_utc}` : '',
    timing ? 'ok' : 'pending'
  );
  addStep(
    'Target',
    target,
    target?.booking ? `Booking ${target.booking.id}, status ${target.booking.status}, opens ${target.booking_time}` : '',
    target ? 'ok' : 'pending'
  );
  addStep(
    'Reserve',
    reserveSuccess || reserveFailure,
    reserveSuccess
      ? `Attempt ${reserveSuccess.attempt}, ${reserveSuccess.rtt_ms} ms`
      : reserveFailure ? 'Reserve did not complete' : '',
    reserveSuccess ? 'ok' : reserveFailure ? 'fail' : 'pending'
  );
  addStep(
    'Cart',
    cartSuccess || cartFailure,
    cartSuccess
      ? `Shot ${cartSuccess.shot_id}, ${cartSuccess.rtt_ms} ms`
      : cartFailure ? 'Add to cart did not complete' : '',
    cartSuccess ? 'ok' : cartFailure ? 'fail' : 'pending'
  );
  addStep(
    'Checkout',
    checkout,
    checkout ? `${checkout.success || 'no success flag'}${checkout.rtt_ms ? `, ${checkout.rtt_ms} ms` : ''}` : '',
    checkout?.success === 'ok' ? 'ok' : checkout ? 'fail' : 'pending'
  );
  addStep(
    'Complete',
    complete || tooEarly || exception,
    complete
      ? `Total ${complete.total_time_seconds}s`
      : tooEarly ? 'Exited before prefire window' : exception?.error || '',
    complete ? 'ok' : tooEarly || exception ? 'fail' : 'pending'
  );

  let reason = '';
  if (complete) reason = 'Completed';
  else if (tooEarly) reason = 'Exited before the booking window';
  else if (exception) reason = `Exception: ${exception.error}`;
  else if (cartFailure) reason = 'Add to cart failed';
  else if (reserveFailure) reason = 'Reserve failed';
  else if (checkSuccess(messages)) reason = 'Success response found';

  return { reason, steps };
}
