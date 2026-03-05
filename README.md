# IFCGraphViewer

A standalone graph + 3D viewer platform for parsed IFC outputs.

This repository consumes outputs from `IFC2StructuredData` (`attribute.csv`, `relationships.csv`, `geometry_instance.csv`, `geometry_library.csv`, optional OBJ files) and provides:

1. Property-graph ingest (Neo4j optional)
2. Backend API for object/graph/geometry queries
3. Dual-pane frontend (3D model + graph) with bidirectional selection
4. Viewer asset builder (`model.glb` + `object_index.json`)
5. Acceptance checks and test suite

## Project Structure

```
backend/         # FastAPI app and graph services
frontend/        # Web UI (Three.js + Cytoscape)
graph_ingest/    # CSV -> graph dataset + Neo4j importer
viewer_assets/   # IFC -> GLB + object index builder
scripts/         # CLI entrypoints
tests/           # Unit tests
docs/            # Runbook, acceptance, limits, backlog
```

## Install

```bash
cd /Users/zijian/Desktop/IFCGraphViewer
pip install -r requirements.txt
```

## Quick Demo (`example_room`)

This repo includes a runnable sample IFC model:

- `example_room/simple-room.ifc`
- `example_room/parsed_output/*` (CSV outputs + `viewer/model.glb` + `viewer/object_index.json`)

Run the viewer directly with the bundled sample:

```bash
GRAPH_STORE_MODE=csv \
GRAPH_OUTPUT_DIR=/Users/zijian/Desktop/IFCGraphViewer/example_room/parsed_output \
VIEWER_INDEX_PATH=/Users/zijian/Desktop/IFCGraphViewer/example_room/parsed_output/viewer/object_index.json \
VIEWER_FILES_DIR=/Users/zijian/Desktop/IFCGraphViewer/example_room/parsed_output/viewer \
FRONTEND_DIR=/Users/zijian/Desktop/IFCGraphViewer/frontend \
VIEWER_MODEL_URL=/viewer-files/model.glb \
python -m uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8000
```

Open:

1. `http://127.0.0.1:8000/`
2. `http://127.0.0.1:8000/docs`

To regenerate `example_room/parsed_output` from IFC, use `IFC2StructuredData` on branch `dev/pm`:

```bash
cd /Users/zijian/Desktop/IFC2StructuredData
git checkout dev/pm
python ifc2structureddata.py \
  /Users/zijian/Desktop/IFCGraphViewer/example_room/simple-room.ifc \
  /Users/zijian/Desktop/IFCGraphViewer/example_room/parsed_output

cd /Users/zijian/Desktop/IFCGraphViewer
python scripts/build_viewer_assets.py \
  /Users/zijian/Desktop/IFCGraphViewer/example_room/simple-room.ifc \
  /Users/zijian/Desktop/IFCGraphViewer/example_room/parsed_output \
  --threads 4
```

## Core Workflows

### 1) Build graph dataset / import to Neo4j

```bash
python scripts/import_graph_to_neo4j.py /abs/path/parsed_output --dry-run

# real import
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USER=neo4j
export NEO4J_PASSWORD='your_password'
export NEO4J_DATABASE=neo4j
python scripts/import_graph_to_neo4j.py /abs/path/parsed_output --replace
```

### 2) Build viewer assets

```bash
python scripts/build_viewer_assets.py /abs/path/model.ifc /abs/path/parsed_output --threads 4
```

Outputs:

1. `/abs/path/parsed_output/viewer/model.glb`
2. `/abs/path/parsed_output/viewer/object_index.json`

Notes:

1. `IfcOpeningElement` is excluded from GLB rendering in V1.

### 3) Run API + UI (CSV mode)

```bash
GRAPH_STORE_MODE=csv \
GRAPH_OUTPUT_DIR=/abs/path/parsed_output \
VIEWER_INDEX_PATH=/abs/path/parsed_output/viewer/object_index.json \
VIEWER_FILES_DIR=/abs/path/parsed_output/viewer \
FRONTEND_DIR=/Users/zijian/Desktop/IFCGraphViewer/frontend \
VIEWER_MODEL_URL=/viewer-files/model.glb \
python -m uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8000
```

Startup guard:

1. Backend validates overlap between `VIEWER_INDEX_PATH` and graph object IDs.
2. If overlap is too low, startup fails with a clear mismatch error.
3. Tuning knobs:
   - `VIEWER_INDEX_MIN_OVERLAP` (default `1`)
   - `VIEWER_INDEX_VALIDATION_SAMPLE_SIZE` (default `5000`)

Open:

1. `http://127.0.0.1:8000/`
2. `http://127.0.0.1:8000/docs`

### 4) Run API (Neo4j mode)

```bash
GRAPH_STORE_MODE=neo4j \
NEO4J_URI=bolt://localhost:7687 \
NEO4J_USER=neo4j \
NEO4J_PASSWORD='your_password' \
NEO4J_DATABASE=neo4j \
VIEWER_INDEX_PATH=/abs/path/parsed_output/viewer/object_index.json \
VIEWER_FILES_DIR=/abs/path/parsed_output/viewer \
FRONTEND_DIR=/Users/zijian/Desktop/IFCGraphViewer/frontend \
VIEWER_MODEL_URL=/viewer-files/model.glb \
python -m uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8000
```

## Tests

```bash
python -m unittest discover -s tests -v
```

Acceptance:

```bash
python scripts/acceptance_check.py \
  --output-dir /abs/path/parsed_output \
  --report-path docs/acceptance_report.json
```

## UI Highlights

1. Node/edge inspector
2. Double-click expansion
3. Edge-name inspection
4. Topology highlighting (`IfcSite`, `IfcBuilding`, `IfcBuildingStorey`)
5. `Topology Focus` toggle to fade non-topology nodes

## Related Repository

Parser repository:

- [IFC2StructuredData](https://github.com/ZijianWang-ZW/IFC2StructuredData)
