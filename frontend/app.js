import * as THREE from 'https://esm.sh/three@0.161.0';
import { OrbitControls } from 'https://esm.sh/three@0.161.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.161.0/examples/jsm/loaders/GLTFLoader.js';
import cytoscape from 'https://esm.sh/cytoscape@3.29.2';

const GRAPH_CONTROL_IDS = [
  'hopsSelect',
  'btnBigPicture',
  'btnBackToFocus',
  'btnTopologyFocus',
  'globalIdInput',
  'btnFocus',
  'objectTypeFilter',
  'relationshipFilter',
  'toggleGeometry',
  'toggleLabels',
  'btnResetFilters',
];

const CAMERA_CONTROL_IDS = ['btnCamFit', 'btnCamIso', 'btnCamTop', 'btnCamFront'];
const TOPOLOGY_IFC_TYPES = new Set(['IfcSite', 'IfcBuilding', 'IfcBuildingStorey']);
const TOPOLOGY_RELATIONSHIP_TYPES = new Set([
  'IfcRelAggregates',
  'IfcRelContainedInSpatialStructure',
]);
const FULL_GRAPH_MAX_LIMIT = 5000;
const DEFAULT_FULL_GRAPH_LIMIT = 1000;
const SELECTION_ACCENT_HEX = '#0b5ed7';
const SELECTION_ACCENT_RGB = 0x0b5ed7;
const VIEWER_HIGHLIGHT_INTENSITY = 0.72;
const INSPECTOR_COLLAPSE_ROW_THRESHOLD = 10;

const state = {
  viewerModelUrl: '/viewer-files/model.glb',
  selectedGlobalId: null,
  viewerIndex: {},
  objectTypeMap: {},
  geometryNodeMap: new Map(),
  objectDetailCache: new Map(),
  geometryDetailCache: new Map(),
  neighborhoodCache: new Map(),
  fullGraphCache: new Map(),
  graphMode: 'none',
  currentCenterGlobalId: null,
  currentHops: 1,
  lastLocalView: null,
  filters: {
    objectType: 'ALL',
    relationshipType: 'ALL',
    showGeometry: true,
    showLabels: true,
    topologyFocus: false,
  },
  graphBusyCount: 0,
  lastNodeTapAt: 0,
  lastNodeTapId: null,
  graphContextNodeId: null,
  graphPreviewNodeId: null,
  graphTooltipEl: null,
  cy: null,
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  raycaster: null,
  mouse: null,
  loadedRoot: null,
  objectMap: new Map(),
  viewerHighlightedObjectIds: new Set(),
};

function setStatus(id, text, error = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', Boolean(error));
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function isTopologyIfcType(ifcType) {
  return TOPOLOGY_IFC_TYPES.has(String(ifcType || ''));
}

function isTopologyRelationship(relationshipType) {
  return TOPOLOGY_RELATIONSHIP_TYPES.has(String(relationshipType || ''));
}

function normalizeName(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text;
}

function buildBuildingNodeLabel(objectRow) {
  const ifcType = objectRow.ifcType || 'Unknown';
  const name = normalizeName(objectRow.name);
  if (name) return `${name}\n${ifcType}`;
  return `${ifcType}\n${objectRow.GlobalId}`;
}

function ensureGraphTooltip() {
  if (state.graphTooltipEl) return state.graphTooltipEl;
  const parent = document.getElementById('graphCanvas');
  if (!parent) return null;
  const el = document.createElement('div');
  el.className = 'graphTooltip';
  parent.appendChild(el);
  state.graphTooltipEl = el;
  return el;
}

function hideGraphTooltip() {
  const el = state.graphTooltipEl;
  if (!el) return;
  el.classList.remove('visible');
}

function showGraphTooltip(evt, node) {
  const el = ensureGraphTooltip();
  if (!el || !state.cy) return;
  const data = node.data() || {};
  const nodeType = data.type === 'geometry' ? 'Geometry' : (data.ifcType || 'BuildingObject');
  const title = data.type === 'geometry'
    ? `Geometry#${data.definitionId}`
    : (normalizeName(data.name) || data.ifcType || data.globalId || 'BuildingObject');
  const detail = data.type === 'geometry'
    ? `DefinitionId: ${data.definitionId}`
    : `GlobalId: ${data.globalId}`;
  el.textContent = `${title}\n${nodeType}\n${detail}`;

  const pos = evt.renderedPosition || { x: 0, y: 0 };
  el.style.left = `${Math.round(pos.x + 14)}px`;
  el.style.top = `${Math.round(pos.y + 14)}px`;
  el.classList.add('visible');
}

function setControlsDisabled(ids, disabled) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  }
}

function beginGraphBusy(message) {
  state.graphBusyCount += 1;
  setControlsDisabled(GRAPH_CONTROL_IDS, true);
  if (message) setStatus('graphStatus', message);
}

function endGraphBusy() {
  state.graphBusyCount = Math.max(0, state.graphBusyCount - 1);
  if (state.graphBusyCount === 0) {
    setControlsDisabled(GRAPH_CONTROL_IDS, false);
    updateBackButtonState();
  }
}

function stringifyForInspector(value) {
  const maxString = 1600;
  return JSON.stringify(
    value,
    (_key, v) => {
      if (typeof v === 'string' && v.length > maxString) {
        return `${v.slice(0, maxString)} ... [truncated ${v.length - maxString} chars]`;
      }
      return v;
    },
    2
  );
}

function isEmptyInspectorValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const text = value.trim().toLowerCase();
  return text === '' || text === 'null' || text === 'none' || text === 'nan';
}

function parseJsonLikeString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (!(text.startsWith('{') || text.startsWith('['))) return null;
  try {
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function toInspectorText(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'object') return stringifyForInspector(value);
  return String(value);
}

function makeInspectorValueElement(value, { mono = false } = {}) {
  const valueEl = document.createElement('div');
  valueEl.className = `inspectorValue${mono ? ' mono' : ''}`;

  const parsedJson = typeof value === 'string' ? parseJsonLikeString(value) : null;
  const text = parsedJson !== null
    ? JSON.stringify(parsedJson, null, 2)
    : toInspectorText(value);
  const normalized = typeof text === 'string' ? text : String(text);
  const isMultiLine = normalized.includes('\n') || normalized.length > 160;

  if (isMultiLine) {
    const pre = document.createElement('pre');
    pre.className = `inspectorJson${mono ? ' mono' : ''}`;
    pre.textContent = normalized;
    valueEl.appendChild(pre);
  } else {
    valueEl.textContent = normalized;
  }
  return valueEl;
}

function appendInspectorSection(container, title, rows, options = {}) {
  const section = document.createElement('section');
  section.className = 'inspectorSection';

  const heading = document.createElement('h4');
  heading.className = 'inspectorSectionTitle';
  heading.textContent = title;
  section.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'inspectorGrid';
  for (const row of rows) {
    if (!row || !row.label) continue;
    const keyEl = document.createElement('div');
    keyEl.className = 'inspectorKey';
    keyEl.textContent = row.label;
    grid.appendChild(keyEl);
    grid.appendChild(makeInspectorValueElement(row.value, { mono: Boolean(row.mono) }));
  }
  section.appendChild(grid);

  if (options.note) {
    const note = document.createElement('div');
    note.className = 'inspectorNote';
    note.textContent = String(options.note);
    section.appendChild(note);
  }

  container.appendChild(section);
}

function formatPropertyValueForDisplay(value) {
  const parsed = typeof value === 'string' ? parseJsonLikeString(value) : null;
  const raw = parsed !== null ? parsed : value;

  if (raw === null || raw === undefined || raw === '') return '—';
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : '—';
  if (typeof raw === 'string') return raw;

  if (Array.isArray(raw)) {
    if (!raw.length) return '[]';
    const parts = raw.map((item) => formatPropertyValueForDisplay(item));
    return `[${parts.join(', ')}]`;
  }

  if (typeof raw === 'object') {
    const entries = Object.entries(raw).filter(([, v]) => !isEmptyInspectorValue(v));
    if (!entries.length) return '{}';
    return entries
      .map(([k, v]) => `${k}: ${formatPropertyValueForDisplay(v)}`)
      .join(' | ');
  }

  return String(raw);
}

function appendInspectorProperties(container, attributes) {
  const entries = Object.entries(attributes || {});
  const nonEmpty = entries.filter(([, value]) => !isEmptyInspectorValue(value));
  const hiddenCount = entries.length - nonEmpty.length;

  const wrapper = document.createElement('section');
  wrapper.className = 'inspectorSection';

  const details = document.createElement('details');
  details.className = 'inspectorDetails';
  details.open = nonEmpty.length <= INSPECTOR_COLLAPSE_ROW_THRESHOLD;

  const summary = document.createElement('summary');
  summary.textContent = `Properties (${nonEmpty.length})`;
  details.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'inspectorPropertyList';
  for (const [key, value] of nonEmpty.sort((a, b) => a[0].localeCompare(b[0]))) {
    const row = document.createElement('div');
    row.className = 'inspectorPropertyRow';

    const keyEl = document.createElement('span');
    keyEl.className = 'inspectorPropertyKey';
    keyEl.textContent = `${key}: `;
    row.appendChild(keyEl);

    const valueEl = document.createElement('span');
    valueEl.className = 'inspectorPropertyValue';
    const formatted = formatPropertyValueForDisplay(value);
    valueEl.textContent = formatted;
    row.appendChild(valueEl);

    list.appendChild(row);
  }
  details.appendChild(list);
  wrapper.appendChild(details);

  if (hiddenCount > 0) {
    const note = document.createElement('div');
    note.className = 'inspectorNote';
    note.textContent = `${hiddenCount} empty properties are hidden to keep this view readable.`;
    wrapper.appendChild(note);
  }

  container.appendChild(wrapper);
}

function appendInspectorJsonDetails(container, title, value, summaryLabel = 'Show JSON') {
  if (value === null || value === undefined || value === '') return;
  const section = document.createElement('section');
  section.className = 'inspectorSection';

  const heading = document.createElement('h4');
  heading.className = 'inspectorSectionTitle';
  heading.textContent = title;
  section.appendChild(heading);

  const details = document.createElement('details');
  details.className = 'inspectorDetails';
  const summary = document.createElement('summary');
  summary.textContent = summaryLabel;
  details.appendChild(summary);
  details.appendChild(makeInspectorValueElement(value, { mono: true }));
  section.appendChild(details);
  container.appendChild(section);
}

function setInspector(title, payload) {
  const el = document.getElementById('detailContent');
  if (!el) return;
  el.replaceChildren();

  if (typeof payload === 'string') {
    const section = document.createElement('section');
    section.className = 'inspectorSection';
    const heading = document.createElement('h4');
    heading.className = 'inspectorSectionTitle';
    heading.textContent = title;
    section.appendChild(heading);
    section.appendChild(makeInspectorValueElement(payload));
    el.appendChild(section);
    return;
  }

  if (payload && typeof payload === 'object') {
    appendInspectorSection(
      el,
      title,
      Object.entries(payload).map(([label, value]) => ({ label, value })),
    );
    return;
  }

  appendInspectorSection(el, title, [{ label: 'Value', value: payload }]);
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function runGraphTask(message, task) {
  beginGraphBusy(message);
  try {
    return await task();
  } catch (err) {
    setStatus('graphStatus', `Graph error: ${err.message || err}`, true);
    setInspector('Graph Error', { message: String(err) });
    throw err;
  } finally {
    endGraphBusy();
  }
}

function runUiTask(task) {
  task().catch((err) => {
    console.error(err);
  });
}

async function loadConfig() {
  try {
    const config = await fetchJson('/api/config');
    if (config.viewerModelUrl) state.viewerModelUrl = config.viewerModelUrl;
  } catch (err) {
    console.warn('config fetch failed', err);
  }
}

function initThree() {
  const container = document.getElementById('viewerCanvas');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6f9fc);

  const camera = new THREE.PerspectiveCamera(60, container.clientWidth / Math.max(container.clientHeight, 1), 0.1, 50000);
  camera.position.set(20, 20, 20);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const ambient = new THREE.AmbientLight(0xffffff, 0.75);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(10, 20, 10);
  scene.add(ambient, dir);

  const grid = new THREE.GridHelper(200, 40, 0x9ca3af, 0xd1d5db);
  scene.add(grid);

  state.scene = scene;
  state.camera = camera;
  state.renderer = renderer;
  state.controls = controls;
  state.raycaster = new THREE.Raycaster();
  state.mouse = new THREE.Vector2();

  function onResize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w <= 0 || h <= 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', onResize);

  renderer.domElement.addEventListener('click', onViewerClick);

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

function getFocusObject() {
  if (state.selectedGlobalId) {
    const selected = state.objectMap.get(state.selectedGlobalId);
    if (selected) return selected;
  }
  return state.loadedRoot || null;
}

function moveCameraToBox(box, preset = 'iso') {
  if (!state.camera || !state.controls) return;
  if (!isFinite(box.min.x)) return;
  const center = box.getCenter(new THREE.Vector3());
  const sizeVec = box.getSize(new THREE.Vector3());
  const radius = Math.max(sizeVec.length(), 1);
  const dist = Math.max(5, radius * 0.9);

  let direction;
  if (preset === 'top') direction = new THREE.Vector3(0.05, 1, 0.05);
  else if (preset === 'front') direction = new THREE.Vector3(0.05, 0.2, 1);
  else if (preset === 'fit') direction = new THREE.Vector3(0.8, 0.7, 0.8);
  else direction = new THREE.Vector3(1, 1, 1);

  direction.normalize();
  state.camera.position.copy(center.clone().add(direction.multiplyScalar(dist)));
  state.controls.target.copy(center);
  state.controls.update();
}

function applyCameraPreset(preset) {
  const targetObj = getFocusObject();
  if (!targetObj) return;
  const box = new THREE.Box3().setFromObject(targetObj);
  moveCameraToBox(box, preset);
}

function focusCameraToObject(obj) {
  if (!obj) return;
  const box = new THREE.Box3().setFromObject(obj);
  moveCameraToBox(box, 'iso');
}

function restoreViewerObjectMaterial(rootObj) {
  if (!rootObj) return;
  rootObj.traverse((child) => {
    if (!child.isMesh) return;
    const original = child.userData.__originalMaterial;
    if (original !== undefined) {
      child.material = original;
      delete child.userData.__originalMaterial;
    }
  });
}

function clearViewerHighlights() {
  for (const gid of state.viewerHighlightedObjectIds) {
    const rootObj = state.objectMap.get(gid);
    restoreViewerObjectMaterial(rootObj);
  }
  state.viewerHighlightedObjectIds.clear();
}

function highlightViewerObject(globalId) {
  const rootObj = state.objectMap.get(globalId);
  if (!rootObj) return false;

  const accent = new THREE.Color(SELECTION_ACCENT_RGB);
  let hasMesh = false;
  rootObj.traverse((child) => {
    if (!child.isMesh) return;
    hasMesh = true;

    if (child.userData.__originalMaterial === undefined) {
      child.userData.__originalMaterial = child.material;
    }

    const cloned = Array.isArray(child.material)
      ? child.material.map((mat) => mat.clone())
      : child.material.clone();

    const paint = (mat) => {
      if (!mat) return;
      if ('emissive' in mat && mat.emissive) {
        mat.emissive.copy(accent);
      } else if ('color' in mat && mat.color) {
        mat.color.lerp(accent, 0.33);
      }
      if ('emissiveIntensity' in mat) {
        mat.emissiveIntensity = VIEWER_HIGHLIGHT_INTENSITY;
      }
    };

    if (Array.isArray(cloned)) cloned.forEach(paint);
    else paint(cloned);

    child.material = cloned;
  });

  if (!hasMesh) return false;
  state.viewerHighlightedObjectIds.add(globalId);
  return true;
}

function setViewerHighlights(globalIds, { focusGlobalId = null } = {}) {
  clearViewerHighlights();
  const uniqueIds = [...new Set((globalIds || []).filter(Boolean))];
  for (const gid of uniqueIds) {
    highlightViewerObject(gid);
  }

  const focusId = focusGlobalId && uniqueIds.includes(focusGlobalId)
    ? focusGlobalId
    : uniqueIds[0];
  if (focusId) {
    const rootObj = state.objectMap.get(focusId);
    if (rootObj) focusCameraToObject(rootObj);
  }
}

function findGlobalIdFromIntersection(object) {
  let cur = object;
  while (cur) {
    if (cur.name && state.viewerIndex[cur.name]) return cur.name;
    cur = cur.parent;
  }
  return null;
}

function onViewerClick(event) {
  if (!state.renderer || !state.camera || !state.scene) return;
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.mouse, state.camera);

  const intersects = state.raycaster.intersectObjects(state.scene.children, true);
  if (!intersects.length) return;
  const gid = findGlobalIdFromIntersection(intersects[0].object);
  if (gid) runUiTask(() => selectObject(gid, 'viewer'));
}

async function loadViewerModel() {
  setStatus('viewerStatus', `Viewer: loading ${state.viewerModelUrl}`);
  setControlsDisabled(CAMERA_CONTROL_IDS, true);
  const loader = new GLTFLoader();

  return new Promise((resolve, reject) => {
    loader.load(
      state.viewerModelUrl,
      (gltf) => {
        try {
          if (state.loadedRoot) state.scene.remove(state.loadedRoot);
          state.loadedRoot = gltf.scene;
          state.scene.add(gltf.scene);

          state.objectMap.clear();
          gltf.scene.traverse((obj) => {
            if (obj.name && state.viewerIndex[obj.name]) {
              state.objectMap.set(obj.name, obj);
            }
          });
          setStatus('viewerStatus', `Viewer: mapped ${state.objectMap.size} objects`);
          setControlsDisabled(CAMERA_CONTROL_IDS, false);
          resolve();
        } catch (err) {
          setStatus('viewerStatus', `Viewer map failed: ${err.message || err}`, true);
          setControlsDisabled(CAMERA_CONTROL_IDS, false);
          reject(err);
        }
      },
      undefined,
      (err) => {
        setStatus('viewerStatus', `Viewer load failed: ${err.message || err}`, true);
        setControlsDisabled(CAMERA_CONTROL_IDS, false);
        reject(err);
      }
    );
  });
}

function initGraph() {
  state.cy = cytoscape({
    container: document.getElementById('graphCanvas'),
    elements: [],
    hideEdgesOnViewport: true,
    textureOnViewport: true,
    motionBlur: false,
    pixelRatio: 1,
    style: [
      {
        selector: 'node[type = "building"]',
        style: {
          'background-color': '#0f766e',
          label: 'data(label)',
          'font-size': 10,
          'min-zoomed-font-size': 7,
          'text-wrap': 'wrap',
          'text-overflow-wrap': 'anywhere',
          'text-max-width': 170,
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 7,
          'text-background-color': '#ffffff',
          'text-background-opacity': 0.82,
          'text-background-shape': 'roundrectangle',
          'text-background-padding': 1.5,
          'text-border-opacity': 0,
          width: 24,
          height: 24,
          color: '#0f172a',
        },
      },
      {
        selector: 'node[type = "building"][isTopologyNode = 1]',
        style: {
          'background-color': '#374151',
          'border-width': 2,
          'border-color': '#111827',
          width: 30,
          height: 30,
        },
      },
      {
        selector: 'node[type = "geometry"]',
        style: {
          'background-color': '#d97706',
          shape: 'diamond',
          label: 'data(label)',
          'font-size': 10,
          'min-zoomed-font-size': 7,
          'text-wrap': 'wrap',
          'text-overflow-wrap': 'anywhere',
          'text-max-width': 120,
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 7,
          'text-background-color': '#ffffff',
          'text-background-opacity': 0.82,
          'text-background-shape': 'roundrectangle',
          'text-background-padding': 1.5,
          width: 24,
          height: 24,
        },
      },
      {
        selector: 'node.context',
        style: {
          'border-width': 3,
          'border-color': '#0b5ed7',
        },
      },
      {
        selector: 'node.hovered',
        style: {
          'border-width': 3,
          'border-color': '#f59e0b',
          'z-index': 9999,
        },
      },
      {
        selector: 'node.selected, node.linked-selected',
        style: {
          'border-width': 4,
          'border-color': SELECTION_ACCENT_HEX,
          'border-opacity': 1,
          'background-color': '#2563eb',
          'z-index': 9999,
        },
      },
      {
        selector: 'edge[type = "relates"]',
        style: {
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'target-arrow-color': '#94a3b8',
          'line-color': '#94a3b8',
          width: 1.4,
          opacity: 0.9,
        },
      },
      {
        selector: 'edge[type = "relates"][isTopologyEdge = 1]',
        style: {
          'line-color': '#3b82f6',
          'target-arrow-color': '#3b82f6',
          width: 2.2,
        },
      },
      {
        selector: 'edge[type = "uses"]',
        style: {
          'line-color': '#f59e0b',
          'target-arrow-shape': 'triangle',
          'target-arrow-color': '#f59e0b',
          'line-style': 'dashed',
          width: 1.2,
          opacity: 0.85,
        },
      },
      {
        selector: 'edge.context',
        style: {
          width: 2.6,
          opacity: 1,
        },
      },
      {
        selector: 'edge.selected-edge',
        style: {
          width: 3,
          'line-color': SELECTION_ACCENT_HEX,
          'target-arrow-color': SELECTION_ACCENT_HEX,
          label: 'data(relationshipType)',
          'font-size': 9,
          color: '#1e293b',
          'text-rotation': 'autorotate',
          'text-background-color': '#ffffff',
          'text-background-opacity': 0.88,
          'text-background-padding': 1.5,
        },
      },
      {
        selector: '.faded',
        style: {
          opacity: 0.14,
        },
      },
      {
        selector: '.hidden',
        style: {
          display: 'none',
        },
      },
    ],
    layout: { name: 'grid' },
  });

  state.cy.on('tap', 'node', (evt) => {
    runUiTask(async () => {
      const node = evt.target;
      const type = node.data('type');
      const now = Date.now();
      const isDoubleTap = state.lastNodeTapId === node.id() && now - state.lastNodeTapAt < 350;
      state.lastNodeTapAt = now;
      state.lastNodeTapId = node.id();
      setPersistentGraphContext(node.id());

      if (type === 'building') {
        const gid = node.data('globalId');
        await selectObject(gid, 'graph');
        if (isDoubleTap) {
          await expandNeighborhood(gid);
        }
        return;
      }

      if (type === 'geometry') {
        const defId = Number(node.data('definitionId'));
        const linkedObjectIds = highlightGeometryInstances(defId);
        setViewerHighlights(linkedObjectIds, { focusGlobalId: linkedObjectIds[0] || null });
        state.selectedGlobalId = linkedObjectIds.length === 1 ? linkedObjectIds[0] : null;
        setText('selectedId', `Geometry#${defId}`);
        setText('selectedType', `GeometryDefinition (${linkedObjectIds.length} objects)`);
        await showGeometryDetails(defId);
      }
    });
  });

  state.cy.on('tap', 'edge', (evt) => {
    const edge = evt.target;
    markEdgeSelection(edge.id());
    setPersistentGraphContext(edge.source().id());
    showEdgeDetails(edge.data());
  });

  state.cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    state.graphPreviewNodeId = node.id();
    showGraphTooltip(evt, node);
    applyGraphContext();
  });

  state.cy.on('mousemove', 'node', (evt) => {
    showGraphTooltip(evt, evt.target);
  });

  state.cy.on('mouseout', 'node', () => {
    state.graphPreviewNodeId = null;
    hideGraphTooltip();
    applyGraphContext();
  });

  state.cy.on('tap', (evt) => {
    if (evt.target === state.cy) {
      clearEdgeSelection();
      applyGraphNodeSelection({ primaryNodeId: null, linkedGlobalIds: [] });
      state.graphContextNodeId = null;
      state.graphPreviewNodeId = null;
      state.selectedGlobalId = null;
      clearViewerHighlights();
      setText('selectedId', 'None');
      setText('selectedType', '-');
      hideGraphTooltip();
      applyGraphContext();
    }
  });
}

function updateBackButtonState() {
  const btn = document.getElementById('btnBackToFocus');
  if (!btn) return;
  btn.disabled = state.graphBusyCount > 0 || !state.lastLocalView;
}

function updateSelectOptions(selectId, values, allLabel) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const previous = select.value || 'ALL';
  const sorted = Array.from(values).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));

  const frag = document.createDocumentFragment();
  const allOpt = document.createElement('option');
  allOpt.value = 'ALL';
  allOpt.textContent = allLabel;
  frag.appendChild(allOpt);
  for (const value of sorted) {
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = String(value);
    frag.appendChild(opt);
  }
  select.replaceChildren(frag);
  select.value = sorted.includes(previous) ? previous : 'ALL';
}

function updateTopologyButton() {
  const btn = document.getElementById('btnTopologyFocus');
  if (!btn) return;
  if (state.filters.topologyFocus) {
    btn.textContent = 'Topology Focus: On';
    btn.classList.add('active');
  } else {
    btn.textContent = 'Topology Focus: Off';
    btn.classList.remove('active');
  }
}

function graphElementsFromData(payload, { resetMaps = true } = {}) {
  const elements = [];
  const seenIds = new Set();
  const buildingNodes = payload.nodes?.buildingObjects || [];
  const geometryNodes = payload.nodes?.geometryDefinitions || [];
  const relates = payload.edges?.relatesTo || [];
  const uses = payload.edges?.usesGeometry || [];

  const addElement = (element) => {
    const id = element?.data?.id;
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    elements.push(element);
    return true;
  };

  if (resetMaps) {
    state.objectTypeMap = {};
    state.geometryNodeMap.clear();
  }

  for (const o of buildingNodes) {
    const globalId = normalizeName(o?.GlobalId);
    if (!globalId) continue;
    const ifcType = o.ifcType || 'Unknown';
    state.objectTypeMap[globalId] = ifcType;
    const isTopologyNode = isTopologyIfcType(ifcType) ? 1 : 0;
    const label = buildBuildingNodeLabel({ ...o, GlobalId: globalId });
    addElement({
      data: {
        id: `obj:${globalId}`,
        type: 'building',
        label,
        globalId,
        ifcType,
        name: normalizeName(o.name),
        isTopologyNode,
      },
    });
  }

  for (const g of geometryNodes) {
    const definitionId = Number(g?.definitionId);
    if (!Number.isFinite(definitionId)) continue;
    state.geometryNodeMap.set(definitionId, g);
    addElement({
      data: {
        id: `geo:${definitionId}`,
        type: 'geometry',
        label: `Geometry#${definitionId}`,
        definitionId,
      },
    });
  }

  for (const e of relates) {
    const src = normalizeName(e?.src);
    const dst = normalizeName(e?.dst);
    if (!src || !dst) continue;
    const relationshipType = e.relationshipType || 'RELATES_TO';
    const isTopologyEdge = isTopologyRelationship(relationshipType) ? 1 : 0;
    addElement({
      data: {
        id: `rel:${src}:${dst}:${relationshipType}`,
        source: `obj:${src}`,
        target: `obj:${dst}`,
        type: 'relates',
        relationshipType,
        isTopologyEdge,
      },
    });
  }

  for (const e of uses) {
    const src = normalizeName(e?.src);
    const definitionId = Number(e?.definitionId);
    if (!src || !Number.isFinite(definitionId)) continue;
    addElement({
      data: {
        id: `use:${src}:${definitionId}`,
        source: `obj:${src}`,
        target: `geo:${definitionId}`,
        type: 'uses',
        relationshipType: 'USES_GEOMETRY',
      },
    });
  }

  return elements;
}

function getCurrentHops() {
  return Number(document.getElementById('hopsSelect').value || 1);
}

async function getNeighborhoodPayload(globalId, hops, limit = 500) {
  const key = `${globalId}|${hops}|${limit}`;
  if (state.neighborhoodCache.has(key)) return state.neighborhoodCache.get(key);
  const payload = await fetchJson(`/api/graph/neighborhood?globalId=${encodeURIComponent(globalId)}&hops=${hops}&limit=${limit}`);
  state.neighborhoodCache.set(key, payload);
  return payload;
}

async function getFullGraphPayload(limit = 1000) {
  const normalizedLimit = Math.max(
    1,
    Math.min(FULL_GRAPH_MAX_LIMIT, Number(limit) || DEFAULT_FULL_GRAPH_LIMIT)
  );
  const cacheKey = String(normalizedLimit);
  if (state.fullGraphCache.has(cacheKey)) return state.fullGraphCache.get(cacheKey);
  const payload = await fetchJson(`/api/graph/full?limit=${normalizedLimit}`);
  state.fullGraphCache.set(cacheKey, payload);
  return payload;
}

function runLayout(mode, focusGlobalId = null) {
  if (!state.cy) return;
  const nodeCount = state.cy.nodes().length;
  const base = {
    name: 'cose',
    fit: true,
    padding: 24,
    animate: nodeCount <= 260 ? 'end' : false,
    animationDuration: 260,
    randomize: mode !== 'expand',
    idealEdgeLength: nodeCount <= 250 ? 120 : 90,
    nodeRepulsion: nodeCount <= 250 ? 420000 : 180000,
    edgeElasticity: 70,
    gravity: 0.22,
    numIter: nodeCount <= 250 ? 900 : 450,
  };

  if (mode === 'expand') {
    state.cy.layout({
      ...base,
      fit: false,
      randomize: false,
      numIter: nodeCount <= 250 ? 700 : 360,
    }).run();
    return;
  }

  if (mode === 'big') {
    state.cy.layout({
      ...base,
      fit: true,
      animate: false,
      randomize: true,
      numIter: nodeCount <= 350 ? 700 : 300,
      idealEdgeLength: nodeCount <= 350 ? 100 : 80,
      nodeRepulsion: nodeCount <= 350 ? 220000 : 120000,
    }).run();
    return;
  }

  const focusNodeId = focusGlobalId ? `obj:${focusGlobalId}` : null;
  if (focusNodeId && state.cy.getElementById(focusNodeId).length) {
    state.cy.getElementById(focusNodeId).position({ x: 0, y: 0 });
  }
  state.cy.layout(base).run();
}

function updateFilterOptionsFromGraph() {
  if (!state.cy) return;
  const objectTypes = new Set();
  const relTypes = new Set(['USES_GEOMETRY']);
  state.cy.nodes('[type = "building"]').forEach((node) => {
    objectTypes.add(node.data('ifcType') || 'Unknown');
  });
  state.cy.edges('[type = "relates"]').forEach((edge) => {
    relTypes.add(edge.data('relationshipType') || 'RELATES_TO');
  });
  updateSelectOptions('objectTypeFilter', objectTypes, 'All Types');
  updateSelectOptions('relationshipFilter', relTypes, 'All Relations');
}

function refreshFilterStateFromControls() {
  const objectType = document.getElementById('objectTypeFilter')?.value || 'ALL';
  const relationshipType = document.getElementById('relationshipFilter')?.value || 'ALL';
  const showGeometry = Boolean(document.getElementById('toggleGeometry')?.checked);
  const showLabels = Boolean(document.getElementById('toggleLabels')?.checked);
  const topologyFocus = Boolean(state.filters.topologyFocus);
  state.filters = { objectType, relationshipType, showGeometry, showLabels, topologyFocus };
}

function applyGraphFilters() {
  if (!state.cy) return;
  refreshFilterStateFromControls();

  const { objectType, relationshipType, showGeometry, showLabels } = state.filters;

  state.cy.style()
    .selector('node[type = "building"]')
    .style('label', showLabels ? 'data(label)' : '')
    .selector('node[type = "geometry"]')
    .style('label', showLabels ? 'data(label)' : '')
    .update();

  state.cy.startBatch();
  state.cy.elements().removeClass('hidden');

  const buildingNodes = state.cy.nodes('[type = "building"]');
  const geometryNodes = state.cy.nodes('[type = "geometry"]');
  const edges = state.cy.edges();

  if (objectType !== 'ALL') {
    buildingNodes.forEach((node) => {
      if ((node.data('ifcType') || 'Unknown') !== objectType) {
        node.addClass('hidden');
      }
    });
  }

  if (!showGeometry) {
    geometryNodes.addClass('hidden');
  }

  edges.forEach((edge) => {
    let hide = false;
    const type = edge.data('type');
    const relType = edge.data('relationshipType') || 'RELATES_TO';

    if (relationshipType !== 'ALL' && relType !== relationshipType) {
      hide = true;
    }
    if (!showGeometry && type === 'uses') {
      hide = true;
    }
    if (edge.source().hasClass('hidden') || edge.target().hasClass('hidden')) {
      hide = true;
    }
    if (hide) edge.addClass('hidden');
  });

  if (showGeometry) {
    geometryNodes.forEach((node) => {
      if (node.hasClass('hidden')) return;
      const connectedUses = node.connectedEdges('[type = "uses"]').filter((edge) => !edge.hasClass('hidden'));
      if (connectedUses.length === 0) {
        node.addClass('hidden');
      }
    });
  }

  edges.forEach((edge) => {
    if (edge.source().hasClass('hidden') || edge.target().hasClass('hidden')) {
      edge.addClass('hidden');
    }
  });

  state.cy.endBatch();

  const visibleNodeCount = state.cy.nodes().filter((n) => !n.hasClass('hidden')).length;
  const visibleEdgeCount = state.cy.edges().filter((e) => !e.hasClass('hidden')).length;
  setStatus('graphStatus', `Graph view: ${visibleNodeCount} nodes, ${visibleEdgeCount} edges`);
  applyGraphContext();
}

function replaceGraph(elements, mode, focusGlobalId = null) {
  state.graphContextNodeId = null;
  state.graphPreviewNodeId = null;
  hideGraphTooltip();
  state.cy.startBatch();
  state.cy.elements().remove();
  state.cy.add(elements);
  state.cy.endBatch();
  runLayout(mode, focusGlobalId);
  clearEdgeSelection();
  updateFilterOptionsFromGraph();
  applyGraphFilters();
}

function applyGraphContext() {
  if (!state.cy) return;
  const focusNodeId = state.graphPreviewNodeId || state.graphContextNodeId;
  state.cy.elements().removeClass('faded context hovered');
  const node = state.cy.getElementById(focusNodeId);
  const visible = state.cy.elements().filter((el) => !el.hasClass('hidden'));
  if (!visible.length) return;

  if (state.filters.topologyFocus) {
    const topologyNodes = state.cy.nodes('[isTopologyNode = 1]').filter((n) => !n.hasClass('hidden'));
    const topologyEdges = state.cy.edges('[isTopologyEdge = 1]').filter((e) => !e.hasClass('hidden'));
    const topologySet = topologyNodes.union(topologyEdges);
    visible.difference(topologySet).addClass('faded');
    topologySet.addClass('context');

    if (node && node.length && !node.hasClass('hidden')) {
      node.addClass('context');
      if (state.graphPreviewNodeId && state.graphPreviewNodeId === focusNodeId) {
        node.addClass('hovered');
      }
    }
    return;
  }

  if (!focusNodeId || !node || !node.length || node.hasClass('hidden')) return;
  visible.addClass('faded');
  const neighborhood = node.closedNeighborhood().filter((el) => !el.hasClass('hidden'));
  neighborhood.removeClass('faded');
  neighborhood.addClass('context');
  node.removeClass('context');
  node.addClass('context');

  if (state.graphPreviewNodeId && state.graphPreviewNodeId === focusNodeId) {
    node.addClass('hovered');
  }
}

function setPersistentGraphContext(nodeId) {
  state.graphContextNodeId = nodeId || null;
  state.graphPreviewNodeId = null;
  applyGraphContext();
}

function countTopologyNodes(buildingNodes) {
  let count = 0;
  for (const node of buildingNodes || []) {
    if (isTopologyIfcType(node.ifcType)) count += 1;
  }
  return count;
}

async function refreshNeighborhood(globalId, { force = false } = {}) {
  const hops = getCurrentHops();
  if (
    !force &&
    state.graphMode === 'neighborhood' &&
    state.currentCenterGlobalId === globalId &&
    state.currentHops === hops
  ) {
    return;
  }

  await runGraphTask('Graph: loading neighborhood...', async () => {
    const payload = await getNeighborhoodPayload(globalId, hops, 500);
    const elements = graphElementsFromData(payload, { resetMaps: true });
    if (!elements.length) {
      replaceGraph([], 'neighborhood', globalId);
      setStatus('graphStatus', 'Graph: empty neighborhood result');
      return;
    }

    replaceGraph(elements, 'neighborhood', globalId);
    state.graphMode = 'neighborhood';
    state.currentCenterGlobalId = globalId;
    state.currentHops = hops;
    state.lastLocalView = { globalId, hops };
    updateBackButtonState();
    const topologyCount = countTopologyNodes(payload.nodes.buildingObjects);
    setStatus(
      'graphStatus',
      `Graph: ${payload.nodes.buildingObjects.length} objects, ${payload.edges.relatesTo.length} relations, topology nodes=${topologyCount}`
    );
  });
}

async function expandNeighborhood(globalId) {
  await runGraphTask('Graph: expanding...', async () => {
    const hops = getCurrentHops();
    const expandHops = Math.min(2, hops + 1);
    const payload = await getNeighborhoodPayload(globalId, expandHops, 800);
    const incoming = graphElementsFromData(payload, { resetMaps: false });
    const existingIds = new Set(state.cy.elements().map((el) => el.id()));
    const toAdd = incoming.filter((el) => !existingIds.has(el.data.id));

    if (!toAdd.length) {
      setStatus('graphStatus', 'Graph: no new nodes to expand');
      return;
    }

    state.cy.startBatch();
    state.cy.add(toAdd);
    state.cy.endBatch();
    updateFilterOptionsFromGraph();
    runLayout('expand', globalId);
    applyGraphFilters();
    markGraphSelection(globalId);
    setStatus(
      'graphStatus',
      `Graph expanded(${expandHops}-hop): +${toAdd.length} elements, now ${state.cy.nodes().length} nodes / ${state.cy.edges().length} edges`
    );
  });
}

async function showBigPicture() {
  await runGraphTask('Graph: loading big picture...', async () => {
    if (state.currentCenterGlobalId) {
      state.lastLocalView = {
        globalId: state.currentCenterGlobalId,
        hops: state.currentHops,
      };
    }
    const overview = await fetchJson('/api/graph/overview');
    const totalObjects = Math.max(0, Number(overview?.building_objects) || 0);
    const limit = totalObjects > 0
      ? Math.min(FULL_GRAPH_MAX_LIMIT, totalObjects)
      : DEFAULT_FULL_GRAPH_LIMIT;
    const payload = await getFullGraphPayload(limit);
    const elements = graphElementsFromData(payload, { resetMaps: true });
    replaceGraph(elements, 'big');
    state.graphMode = 'big';
    state.currentCenterGlobalId = null;
    updateBackButtonState();
    const topologyCount = countTopologyNodes(payload.nodes.buildingObjects);
    const loadedObjects = payload.nodes.buildingObjects.length;
    const relationCount = payload.edges.relatesTo.length;
    const isTruncated = totalObjects > limit;
    const objectPart = totalObjects > 0
      ? `${loadedObjects}/${totalObjects}`
      : `${loadedObjects}`;
    const suffix = isTruncated ? `, truncated at limit=${limit}` : '';
    setStatus(
      'graphStatus',
      `Graph(big): ${objectPart} objects, ${relationCount} relations, topology nodes=${topologyCount}${suffix}`
    );
  });
}

async function backToFocusView() {
  if (!state.lastLocalView) return;
  const hopsSelect = document.getElementById('hopsSelect');
  if (hopsSelect) hopsSelect.value = String(state.lastLocalView.hops);
  await refreshNeighborhood(state.lastLocalView.globalId, { force: true });
  markGraphSelection(state.lastLocalView.globalId);
}

function markGraphSelection(globalId) {
  if (!state.cy) return;
  applyGraphNodeSelection({
    primaryNodeId: globalId ? `obj:${globalId}` : null,
    linkedGlobalIds: globalId ? [globalId] : [],
    centerOnPrimary: true,
  });
}

function clearEdgeSelection() {
  if (!state.cy) return;
  state.cy.edges().removeClass('selected-edge');
}

function markEdgeSelection(edgeId) {
  if (!state.cy) return;
  clearEdgeSelection();
  const edge = state.cy.getElementById(edgeId);
  if (edge && edge.length) edge.addClass('selected-edge');
}

function applyGraphNodeSelection({
  primaryNodeId = null,
  linkedGlobalIds = [],
  centerOnPrimary = false,
} = {}) {
  if (!state.cy) return;
  state.cy.nodes().removeClass('selected linked-selected');

  const linkedIds = [...new Set((linkedGlobalIds || []).filter(Boolean))];
  for (const gid of linkedIds) {
    const node = state.cy.getElementById(`obj:${gid}`);
    if (node && node.length) node.addClass('linked-selected');
  }

  if (!primaryNodeId) return;
  const primaryNode = state.cy.getElementById(primaryNodeId);
  if (primaryNode && primaryNode.length) {
    primaryNode.removeClass('linked-selected');
    primaryNode.addClass('selected');
    setPersistentGraphContext(primaryNode.id());
    if (centerOnPrimary) state.cy.center(primaryNode);
  }
}

function highlightGeometryInstances(definitionId) {
  if (!definitionId || !state.cy) return [];
  clearEdgeSelection();
  const edges = state.cy
    .edges()
    .filter((edge) => edge.data('type') === 'uses' && Number(edge.target().data('definitionId')) === Number(definitionId));
  const objectIds = [];
  edges.forEach((edge) => {
    edge.addClass('selected-edge');
    const gid = edge.source().data('globalId');
    if (gid) objectIds.push(gid);
  });
  applyGraphNodeSelection({
    primaryNodeId: `geo:${Number(definitionId)}`,
    linkedGlobalIds: objectIds,
  });
  return [...new Set(objectIds)];
}

function parseAttributes(rawObject) {
  if (rawObject?.attributes && typeof rawObject.attributes === 'object') {
    return rawObject.attributes;
  }
  if (typeof rawObject?.attributesJson === 'string' && rawObject.attributesJson) {
    try {
      return JSON.parse(rawObject.attributesJson);
    } catch (err) {
      return { parseError: String(err) };
    }
  }
  return {};
}

async function showBuildingDetails(globalId) {
  const detail = await getBuildingDetail(globalId);
  renderBuildingDetails(globalId, detail);
}

async function getBuildingDetail(globalId) {
  let detail = state.objectDetailCache.get(globalId);
  if (!detail) {
    detail = await fetchJson(`/api/object/${encodeURIComponent(globalId)}`);
    state.objectDetailCache.set(globalId, detail);
  }
  const object = detail?.object;
  if (!object || !object.GlobalId) {
    throw new Error(`Invalid object detail payload for ${globalId}`);
  }
  return detail;
}

function renderBuildingDetails(globalId, detail) {
  const object = detail.object || {};
  const attributes = parseAttributes(object);
  const usesGeometry = (detail.geometry?.uses_geometry_edges || []).map((edge) => ({
    definitionId: edge.definitionId,
    instanceParamsJson: edge.instanceParamsJson || null,
  }));
  const definitionIds = [...new Set(usesGeometry.map((edge) => edge.definitionId).filter((id) => id !== null && id !== undefined))];
  const inspector = document.getElementById('detailContent');
  if (!inspector) return;
  inspector.replaceChildren();

  appendInspectorSection(inspector, 'Node', [
    { label: 'GlobalId', value: object.GlobalId || globalId, mono: true },
    { label: 'IFC Type', value: object.ifcType || 'Unknown' },
    { label: 'Name', value: object.name || '—' },
  ]);

  appendInspectorSection(inspector, 'Geometry', [
    { label: 'Has Geometry', value: object.hasGeometry },
    { label: 'Geometry Method', value: object.geometryMethod || '—' },
    { label: 'Geometry Definition IDs', value: definitionIds.length ? definitionIds.join(', ') : '—', mono: true },
    { label: 'Uses Geometry Edges', value: usesGeometry.length },
    { label: 'OBJ File Path', value: object.hasGeometryFilePath || '—', mono: true },
    {
      label: 'Viewer Mapping',
      value: detail.viewer
        ? `node=${detail.viewer.node_index ?? '-'}, mesh=${detail.viewer.mesh_index ?? '-'}`
        : 'Not mapped in viewer index',
      mono: true,
    },
  ]);

  if (usesGeometry.length) {
    const previewRows = usesGeometry.slice(0, 6).map((edge, idx) => ({
      label: `Edge #${idx + 1}`,
      value: `definitionId=${edge.definitionId}${edge.instanceParamsJson ? ', has instance params' : ''}`,
      mono: true,
    }));
    appendInspectorSection(
      inspector,
      'Uses Geometry Preview',
      previewRows,
      usesGeometry.length > 6 ? { note: `${usesGeometry.length - 6} additional USES_GEOMETRY edges are hidden.` } : {},
    );
  }

  appendInspectorProperties(inspector, attributes);
}

async function showGeometryDetails(definitionId) {
  try {
    let detail = state.geometryDetailCache.get(definitionId);
    if (!detail) {
      detail = await fetchJson(`/api/geometry/${Number(definitionId)}`);
      state.geometryDetailCache.set(definitionId, detail);
    }

    const summary = state.geometryNodeMap.get(Number(definitionId)) || {};
    const connectedObjects = state.cy
      .edges()
      .filter((edge) => edge.data('type') === 'uses' && Number(edge.target().data('definitionId')) === Number(definitionId))
      .map((edge) => edge.source().data('globalId'));
    const uniqueConnected = [...new Set(connectedObjects.filter(Boolean))];
    const geometry = detail.geometry || {};
    const inspector = document.getElementById('detailContent');
    if (!inspector) return;
    inspector.replaceChildren();

    appendInspectorSection(inspector, 'Geometry Node', [
      { label: 'Definition ID', value: Number(definitionId), mono: true },
      { label: 'Method', value: geometry.method || summary.method || '—' },
      { label: 'Representation Type', value: geometry.representationType || summary.representationType || '—' },
    ]);

    appendInspectorSection(inspector, 'Geometry Properties', [
      { label: 'Has Geometry Tree', value: Boolean(geometry.geometryTreeJson) },
      {
        label: 'Geometry Tree Length',
        value: typeof geometry.geometryTreeJson === 'string' ? geometry.geometryTreeJson.length : 0,
      },
      { label: 'Instance Count', value: summary.instanceCount ?? geometry.instanceCount ?? '—' },
      { label: 'Connected Building Objects', value: uniqueConnected.length },
    ]);

    if (uniqueConnected.length) {
      const rows = uniqueConnected.slice(0, 12).map((gid, idx) => ({
        label: `Object #${idx + 1}`,
        value: gid,
        mono: true,
      }));
      appendInspectorSection(
        inspector,
        'Connected Objects',
        rows,
        uniqueConnected.length > 12
          ? { note: `${uniqueConnected.length - 12} additional connected objects are hidden.` }
          : {},
      );
    }

    appendInspectorJsonDetails(inspector, 'Geometry Tree', geometry.geometryTreeJson, 'Show geometry tree JSON');
  } catch (err) {
    setInspector('Geometry Node Attributes', `Failed to load geometry detail: ${err.message || err}`);
  }
}

function showEdgeDetails(edgeData) {
  const name = edgeData.relationshipType || edgeData.type || 'edge';
  const normalizeEndpoint = (value) => {
    const text = String(value || '');
    if (text.startsWith('obj:')) return text.slice(4);
    if (text.startsWith('geo:')) return `Geometry#${text.slice(4)}`;
    return text || '—';
  };
  const inspector = document.getElementById('detailContent');
  if (!inspector) return;
  inspector.replaceChildren();
  appendInspectorSection(inspector, 'Edge', [
    { label: 'Type', value: edgeData.type || '—' },
    { label: 'Name', value: name },
    { label: 'Relationship Type', value: edgeData.relationshipType || '—' },
    { label: 'Source', value: normalizeEndpoint(edgeData.source), mono: true },
    { label: 'Target', value: normalizeEndpoint(edgeData.target), mono: true },
  ]);
}

async function selectObject(globalId, source = 'api') {
  if (!globalId) return;
  const previousGlobalId = state.selectedGlobalId;
  const previousType = previousGlobalId
    ? state.objectTypeMap[previousGlobalId] || '-'
    : '-';

  try {
    if (source !== 'graph') {
      await refreshNeighborhood(globalId);
    }

    const detail = await getBuildingDetail(globalId);

    state.selectedGlobalId = globalId;
    setText('selectedId', globalId);

    setViewerHighlights([globalId], { focusGlobalId: globalId });
    markGraphSelection(globalId);
    clearEdgeSelection();

    renderBuildingDetails(globalId, detail);
    setText('selectedType', state.objectTypeMap[globalId] || detail.object?.ifcType || '-');
  } catch (err) {
    setText('selectedId', previousGlobalId || 'None');
    setText('selectedType', previousType);
    setStatus('graphStatus', `Focus failed: ${err.message || err}`, true);
    throw err;
  }
}

async function loadOverview() {
  try {
    const overview = await fetchJson('/api/graph/overview');
    setText('overviewText', `objects=${overview.building_objects}, edges=${overview.relates_edges}, geoDefs=${overview.geometry_definitions}`);
  } catch (err) {
    setText('overviewText', `Overview failed: ${err.message}`);
  }
}

function bindControls() {
  document.getElementById('btnFocus')?.addEventListener('click', () => {
    runUiTask(async () => {
      const gid = document.getElementById('globalIdInput')?.value.trim();
      if (!gid) return;
      await selectObject(gid, 'api');
    });
  });

  document.getElementById('btnBigPicture')?.addEventListener('click', () => {
    runUiTask(async () => {
      await showBigPicture();
    });
  });

  document.getElementById('btnBackToFocus')?.addEventListener('click', () => {
    runUiTask(async () => {
      await backToFocusView();
    });
  });

  document.getElementById('btnTopologyFocus')?.addEventListener('click', () => {
    state.filters.topologyFocus = !state.filters.topologyFocus;
    updateTopologyButton();
    applyGraphContext();
    const mode = state.filters.topologyFocus ? 'ON' : 'OFF';
    const visibleNodeCount = state.cy ? state.cy.nodes().filter((n) => !n.hasClass('hidden')).length : 0;
    const visibleEdgeCount = state.cy ? state.cy.edges().filter((e) => !e.hasClass('hidden')).length : 0;
    setStatus('graphStatus', `Topology focus ${mode}: ${visibleNodeCount} nodes, ${visibleEdgeCount} edges in current view`);
  });

  document.getElementById('hopsSelect')?.addEventListener('change', () => {
    runUiTask(async () => {
      if (state.selectedGlobalId) {
        await refreshNeighborhood(state.selectedGlobalId, { force: true });
        markGraphSelection(state.selectedGlobalId);
      }
    });
  });

  const filterIds = ['objectTypeFilter', 'relationshipFilter', 'toggleGeometry', 'toggleLabels'];
  for (const id of filterIds) {
    document.getElementById(id)?.addEventListener('change', () => {
      applyGraphFilters();
    });
  }

  document.getElementById('btnResetFilters')?.addEventListener('click', () => {
    const objectType = document.getElementById('objectTypeFilter');
    const relationship = document.getElementById('relationshipFilter');
    const toggleGeometry = document.getElementById('toggleGeometry');
    const toggleLabels = document.getElementById('toggleLabels');
    if (objectType) objectType.value = 'ALL';
    if (relationship) relationship.value = 'ALL';
    if (toggleGeometry) toggleGeometry.checked = true;
    if (toggleLabels) toggleLabels.checked = true;
    state.filters.topologyFocus = false;
    updateTopologyButton();
    applyGraphFilters();
  });

  document.getElementById('btnCamFit')?.addEventListener('click', () => applyCameraPreset('fit'));
  document.getElementById('btnCamIso')?.addEventListener('click', () => applyCameraPreset('iso'));
  document.getElementById('btnCamTop')?.addEventListener('click', () => applyCameraPreset('top'));
  document.getElementById('btnCamFront')?.addEventListener('click', () => applyCameraPreset('front'));
}

async function init() {
  initThree();
  initGraph();
  bindControls();
  updateBackButtonState();
  updateTopologyButton();
  await loadConfig();

  try {
    state.viewerIndex = await fetchJson('/api/viewer/index');
  } catch (err) {
    state.viewerIndex = {};
    console.warn('viewer index load failed', err);
    setStatus('viewerStatus', `Viewer index failed: ${err.message || err}`, true);
  }

  await loadViewerModel();
  await loadOverview();

  const preferred = Object.keys(state.viewerIndex)[0] || null;
  if (preferred) {
    const input = document.getElementById('globalIdInput');
    if (input) input.value = preferred;
    await selectObject(preferred, 'api');
  } else {
    setStatus('graphStatus', 'Graph: no viewer index data available', true);
  }

  window.ifcApp = {
    selectObject,
    showBigPicture,
    refreshNeighborhood,
    expandNeighborhood,
    backToFocusView,
    applyGraphFilters,
    applyCameraPreset,
    state,
  };
}

init().catch((err) => {
  console.error(err);
  setStatus('viewerStatus', `Startup failed: ${err.message || err}`, true);
  setStatus('graphStatus', `Startup failed: ${err.message || err}`, true);
});
