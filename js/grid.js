// MGRS/UTM grid overlay for Leaflet (1 km lines, 100 m when zoomed in).
// Lines are UTM easting/northing lines; labels are the usual last-digits style
// printed in map margins. Uses the global `proj4` and `L`.
import { toMGRS } from './geo.js';

const utmDef = (zone, south) => `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;

export function createGridLayer(map) {
  const group = L.layerGroup();
  const info = L.control({ position: 'bottomleft' });
  let infoDiv;
  info.onAdd = () => {
    infoDiv = L.DomUtil.create('div', 'map-info');
    return infoDiv;
  };

  function redraw() {
    group.clearLayers();
    const z = map.getZoom();
    if (z < 12) {
      if (infoDiv) infoDiv.textContent = 'Zoom in for MGRS grid';
      return;
    }
    const spacing = z >= 16 ? 100 : 1000;
    const b = map.getBounds();
    const c = b.getCenter();
    const zone = Math.floor((c.lng + 180) / 6) + 1;
    const south = c.lat < 0;
    const def = utmDef(zone, south);
    const fwd = (lng, lat) => proj4('EPSG:4326', def, [lng, lat]);
    const inv = (e, n) => proj4(def, 'EPSG:4326', [e, n]); // -> [lng, lat]

    const corners = [fwd(b.getWest(), b.getSouth()), fwd(b.getEast(), b.getSouth()), fwd(b.getWest(), b.getNorth()), fwd(b.getEast(), b.getNorth())];
    const minE = Math.min(...corners.map((p) => p[0])), maxE = Math.max(...corners.map((p) => p[0]));
    const minN = Math.min(...corners.map((p) => p[1])), maxN = Math.max(...corners.map((p) => p[1]));
    const style = { color: '#7a1f1f', weight: 1.2, opacity: 0.75, interactive: false };
    const lbl = (v) => {
      const km = Math.floor(v / 1000) % 100;
      if (spacing >= 1000) return String(km).padStart(2, '0');
      return String(km).padStart(2, '0') + '<sup>' + String(Math.floor((v % 1000) / 100)) + '</sup>';
    };
    const tooMany = (maxE - minE) / spacing > 80 || (maxN - minN) / spacing > 80;
    if (tooMany) return;
    for (let e = Math.ceil(minE / spacing) * spacing; e <= maxE; e += spacing) {
      const p1 = inv(e, minN), p2 = inv(e, maxN);
      L.polyline([[p1[1], p1[0]], [p2[1], p2[0]]], style).addTo(group);
      // label near the top edge of the view
      const pt = inv(e, maxN - (maxN - minN) * 0.02);
      L.marker([pt[1], pt[0]], { interactive: false, icon: L.divIcon({ className: 'gridlbl', html: lbl(e), iconSize: [0, 0] }) }).addTo(group);
    }
    for (let n = Math.ceil(minN / spacing) * spacing; n <= maxN; n += spacing) {
      const p1 = inv(minE, n), p2 = inv(maxE, n);
      L.polyline([[p1[1], p1[0]], [p2[1], p2[0]]], style).addTo(group);
      const pt = inv(minE + (maxE - minE) * 0.01, n);
      L.marker([pt[1], pt[0]], { interactive: false, icon: L.divIcon({ className: 'gridlbl', html: lbl(n), iconSize: [0, 0] }) }).addTo(group);
    }
    if (infoDiv) {
      const sq = toMGRS(c.lat, c.lng, 0); // e.g. "13S ED"
      infoDiv.textContent = `MGRS grid ${sq} · ${spacing >= 1000 ? '1 km' : '100 m'} lines`;
    }
  }

  group.onAdd = ((orig) => function (m) {
    orig.call(this, m);
    info.addTo(m);
    m.on('moveend zoomend', redraw);
    redraw();
  })(group.onAdd);
  group.onRemove = ((orig) => function (m) {
    m.off('moveend zoomend', redraw);
    info.remove();
    orig.call(this, m);
  })(group.onRemove);
  return group;
}
