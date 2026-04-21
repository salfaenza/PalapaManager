import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';

const MAP_IMG_URL = process.env.PUBLIC_URL + '/resort-map.jpg';
const MAP_NATIVE_W = 1397;
const MAP_NATIVE_H = 785;

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.1;

/* iPoolside uses Leaflet with a 1:1 pixel coordinate space on the map image.
   Crucially the axes are swapped:
     loc_lat  →  X pixel position (0 – 1397)
     loc_lon  →  Y pixel position (0 – 785)
   We convert to 0-1 fractions for responsive positioning. */
function coordToFraction(lon, lat) {
  return {
    x: parseFloat(lat) / MAP_NATIVE_W,
    y: parseFloat(lon) / MAP_NATIVE_H,
  };
}

function statusColor(palapa, isChosen) {
  if (isChosen) return 'var(--clr-success)';
  if (palapa.internal_lock) return 'var(--clr-warn)';
  if (!palapa.available) {
    if (palapa.status === 5) return 'var(--clr-staff)';
    if (palapa.status === 2) return 'var(--clr-danger)';
    if (palapa.status === 7 || palapa.status === 50) return 'var(--clr-accent)';
    return 'var(--clr-text-muted)';
  }
  return 'var(--clr-primary)';
}

export default function PalapaMap({ palapas, hutChoices, onAddChoice, onRemoveChoice, typeFilter = 'all' }) {
  const containerRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const [detailPalapa, setDetailPalapa] = useState(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  // Zoom & pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOrigin = useRef({ x: 0, y: 0 });
  const lastTouchDist = useRef(null);

  // Track container size for responsive dot positioning
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setContainerSize({ w: width, h: height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleDotClick = useCallback((palapa, filtered) => {
    if (filtered) return;
    const name = String(palapa.name);
    setDetailPalapa(palapa);
    if (hutChoices.includes(name)) {
      onRemoveChoice?.(name);
    } else {
      onAddChoice?.(name);
    }
  }, [hutChoices, onAddChoice, onRemoveChoice]);

  const dots = useMemo(() =>
    palapas
      .filter((p) => p.loc_lon && p.loc_lat)
      .map((p) => ({ ...p, ...coordToFraction(p.loc_lon, p.loc_lat) })),
    [palapas]
  );

  // Compute rendered image dimensions (object-fit: contain logic)
  const imgRect = useMemo(() => {
    if (!containerSize.w || !containerSize.h) return null;
    const containerAR = containerSize.w / containerSize.h;
    const imgAR = MAP_NATIVE_W / MAP_NATIVE_H;
    let w, h, offsetX, offsetY;
    if (imgAR > containerAR) {
      w = containerSize.w;
      h = containerSize.w / imgAR;
      offsetX = 0;
      offsetY = (containerSize.h - h) / 2;
    } else {
      h = containerSize.h;
      w = containerSize.h * imgAR;
      offsetX = (containerSize.w - w) / 2;
      offsetY = 0;
    }
    return { w, h, offsetX, offsetY };
  }, [containerSize]);

  // --- Zoom helpers ---
  const clampPan = useCallback((px, py, z) => {
    if (z <= 1) return { x: 0, y: 0 };
    const maxPanX = (containerSize.w * (z - 1)) / 2;
    const maxPanY = (containerSize.h * (z - 1)) / 2;
    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, px)),
      y: Math.max(-maxPanY, Math.min(maxPanY, py)),
    };
  }, [containerSize]);

  const applyZoom = useCallback((newZoom, focalX, focalY) => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    setZoom((prevZoom) => {
      const scale = clamped / prevZoom;
      setPan((prevPan) => {
        const nextX = focalX - scale * (focalX - prevPan.x);
        const nextY = focalY - scale * (focalY - prevPan.y);
        return clampPan(nextX, nextY, clamped);
      });
      return clamped;
    });
  }, [clampPan]);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const focalX = e.clientX - rect.left - rect.width / 2;
    const focalY = e.clientY - rect.top - rect.height / 2;
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    applyZoom(zoom + delta, focalX, focalY);
  }, [zoom, applyZoom]);

  // Attach wheel listener with passive:false so we can preventDefault
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const handleZoomIn = () => applyZoom(zoom + ZOOM_STEP, 0, 0);
  const handleZoomOut = () => applyZoom(zoom - ZOOM_STEP, 0, 0);
  const handleZoomReset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  // --- Pan (mouse drag) ---
  const handleMouseDown = useCallback((e) => {
    if (zoom <= 1) return;
    if (e.button !== 0) return;
    isPanning.current = true;
    panStart.current = { x: e.clientX, y: e.clientY };
    panOrigin.current = { ...pan };
    e.preventDefault();
  }, [zoom, pan]);

  const handleMouseMove = useCallback((e) => {
    if (!isPanning.current) return;
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    setPan(clampPan(panOrigin.current.x + dx, panOrigin.current.y + dy, zoom));
  }, [zoom, clampPan]);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  useEffect(() => {
    if (zoom <= 1) return;
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [zoom, handleMouseMove, handleMouseUp]);

  // --- Touch: pinch zoom + pan ---
  const handleTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist.current = Math.hypot(dx, dy);
    } else if (e.touches.length === 1 && zoom > 1) {
      isPanning.current = true;
      panStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      panOrigin.current = { ...pan };
    }
  }, [zoom, pan]);

  const handleTouchMove = useCallback((e) => {
    if (e.touches.length === 2 && lastTouchDist.current !== null) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const scale = dist / lastTouchDist.current;
      lastTouchDist.current = dist;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left - rect.width / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top - rect.height / 2;
      applyZoom(zoom * scale, midX, midY);
    } else if (e.touches.length === 1 && isPanning.current) {
      const dx = e.touches[0].clientX - panStart.current.x;
      const dy = e.touches[0].clientY - panStart.current.y;
      setPan(clampPan(panOrigin.current.x + dx, panOrigin.current.y + dy, zoom));
    }
  }, [zoom, applyZoom, clampPan]);

  const handleTouchEnd = useCallback(() => {
    lastTouchDist.current = null;
    isPanning.current = false;
  }, []);

  return (
    <div className="palapa-map-wrap">
      {!imgLoaded && !imgError && <p className="text-muted" style={{ textAlign: 'center' }}>Loading map...</p>}
      {imgError && <p className="msg-error">Could not load resort map image.</p>}

      <div className="map-zoom-controls">
        <button type="button" onClick={handleZoomIn} className="map-zoom-btn" title="Zoom in">+</button>
        <button type="button" onClick={handleZoomOut} className="map-zoom-btn" title="Zoom out">&minus;</button>
        <button type="button" onClick={handleZoomReset} className="map-zoom-btn map-zoom-btn--reset" title="Reset zoom">
          {Math.round(zoom * 100)}%
        </button>
      </div>

      <div
        className="palapa-map-container"
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ cursor: zoom > 1 ? (isPanning.current ? 'grabbing' : 'grab') : 'crosshair' }}
      >
        <div
          className="palapa-map-inner"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
          }}
        >
          <img
            src={MAP_IMG_URL}
            alt="Resort palapa map"
            className="palapa-map-img"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
            draggable={false}
          />

          {imgLoaded && imgRect && dots.map((p) => {
            const name = String(p.name);
            const chosenIdx = hutChoices.indexOf(name);
            const isChosen = chosenIdx >= 0;
            const dotX = imgRect.offsetX + p.x * imgRect.w;
            const dotY = imgRect.offsetY + p.y * imgRect.h;
            const color = statusColor(p, isChosen);
            const dotScale = 1 / zoom;
            const filtered = typeFilter !== 'all' && p.palapatype_name !== typeFilter;
            const isDetail = detailPalapa && detailPalapa.id === p.id;

            return (
              <button
                key={p.id}
                type="button"
                className={[
                  'map-dot',
                  isChosen && 'map-dot--chosen',
                  !p.available && !isChosen && 'map-dot--unavailable',
                  p.status === 5 && 'map-dot--staff-hold',
                  filtered && 'map-dot--filtered',
                  isDetail && 'map-dot--detail',
                ].filter(Boolean).join(' ')}
                style={{
                  left: `${dotX}px`,
                  top: `${dotY}px`,
                  '--dot-color': color,
                  transform: `scale(${dotScale})`,
                }}
                onClick={() => handleDotClick(p, filtered)}
                onMouseEnter={(e) => {
                  if (filtered) return;
                  setTooltip({ palapa: p, isChosen, chosenIdx, x: e.clientX, y: e.clientY });
                }}
                onMouseLeave={() => setTooltip(null)}
                aria-label={`Palapa ${name} — ${p.status_label}`}
              >
                <span className="map-dot-name">{name}</span>
              </button>
            );
          })}
        </div>

        {tooltip && (
          <MapTooltip
            palapa={tooltip.palapa}
            isChosen={tooltip.isChosen}
            chosenIdx={tooltip.chosenIdx}
            containerRef={containerRef}
            mouseX={tooltip.x}
            mouseY={tooltip.y}
          />
        )}
      </div>

      {detailPalapa && (
        <DetailPanel
          palapa={detailPalapa}
          isChosen={hutChoices.includes(String(detailPalapa.name))}
          chosenIdx={hutChoices.indexOf(String(detailPalapa.name))}
          onAdd={() => onAddChoice?.(String(detailPalapa.name))}
          onRemove={() => onRemoveChoice?.(String(detailPalapa.name))}
          onClose={() => setDetailPalapa(null)}
        />
      )}

      <div className="map-legend">
        <LegendItem color="var(--clr-primary)" label="Available" />
        <LegendItem color="var(--clr-success)" label="Selected" />
        <LegendItem color="var(--clr-danger)" label="Booked" />
        <LegendItem color="var(--clr-accent)" label="Reserved/Cart" />
        <LegendItem color="var(--clr-warn)" label="Held (app)" />
        <LegendItem color="var(--clr-staff)" label="Staff Hold" />
        <LegendItem color="var(--clr-text-muted)" label="Other" />
      </div>
    </div>
  );
}

function DetailPanel({ palapa, isChosen, chosenIdx, onAdd, onRemove, onClose }) {
  return (
    <div className="map-detail-panel">
      <button type="button" className="map-detail-close" onClick={onClose}>&times;</button>
      <div className="map-detail-header">
        <strong>{palapa.name}</strong>
        <span className={`badge ${palapa.available ? 'badge-success' : palapa.status === 5 ? 'badge-warn' : 'badge-danger'}`}>
          {palapa.status_label}
        </span>
      </div>
      <div className="map-detail-info">
        <div className="map-detail-row">
          <span className="map-detail-label">Type</span>
          <span>{palapa.palapatype_name || 'Palapa'}</span>
        </div>
        <div className="map-detail-row">
          <span className="map-detail-label">Zone</span>
          <span>{palapa.zone_name || '\u2014'}</span>
        </div>
        <div className="map-detail-row">
          <span className="map-detail-label">Opens</span>
          <span>{palapa.booking_time || '\u2014'}</span>
        </div>
        {palapa.price != null && (
          <div className="map-detail-row">
            <span className="map-detail-label">Price</span>
            <span>${palapa.price}</span>
          </div>
        )}
        {palapa.lock_reason && (
          <div className="map-detail-row">
            <span className="map-detail-label">Note</span>
            <span className="text-muted">{palapa.lock_reason}</span>
          </div>
        )}
      </div>
      <div className="map-detail-actions">
        {isChosen ? (
          <button type="button" className="btn btn-danger btn-sm" onClick={onRemove}>
            Remove (#{chosenIdx + 1})
          </button>
        ) : palapa.available ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onAdd}>
            Add to Priority List
          </button>
        ) : (
          <span className="text-muted" style={{ fontSize: '0.82rem' }}>Not available</span>
        )}
      </div>
    </div>
  );
}

function MapTooltip({ palapa, isChosen, chosenIdx, containerRef, mouseX, mouseY }) {
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      left: mouseX - rect.left + 12,
      top: mouseY - rect.top - 10,
    });
  }, [mouseX, mouseY, containerRef]);

  return (
    <div className="map-tooltip" style={{ left: pos.left, top: pos.top }}>
      <strong>{palapa.name}</strong>
      <span>{palapa.palapatype_name || 'Palapa'}</span>
      <span>{palapa.zone_name}</span>
      <span className={`badge ${palapa.available ? 'badge-success' : 'badge-danger'}`}>
        {palapa.status_label}
      </span>
      {palapa.booking_time && <span>Opens: {palapa.booking_time}</span>}
      {palapa.price != null && <span>Price: ${palapa.price}</span>}
      {isChosen && <span className="badge badge-success">Priority {chosenIdx + 1}</span>}
      {palapa.lock_reason && <span className="text-muted">{palapa.lock_reason}</span>}
    </div>
  );
}

function LegendItem({ color, label }) {
  return (
    <span className="map-legend-item">
      <span className="map-legend-dot" style={{ background: color }} />
      {label}
    </span>
  );
}
