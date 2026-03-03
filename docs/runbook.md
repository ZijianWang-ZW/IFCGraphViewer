# Runbook

## 1. Install

```bash
cd /Users/zijian/Desktop/IFCGraphViewer
pip install -r requirements.txt
```

## 2. Build Viewer Assets

```bash
python scripts/build_viewer_assets.py /abs/path/model.ifc /abs/path/parsed_output --threads 4
```

## 3. Graph Ingest (Neo4j)

Dry-run:

```bash
python scripts/import_graph_to_neo4j.py /abs/path/parsed_output --dry-run
```

Real import:

```bash
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USER=neo4j
export NEO4J_PASSWORD='your_password'
export NEO4J_DATABASE=neo4j
python scripts/import_graph_to_neo4j.py /abs/path/parsed_output --replace
```

## 4. Run in CSV Mode

```bash
GRAPH_STORE_MODE=csv \
GRAPH_OUTPUT_DIR=/abs/path/parsed_output \
VIEWER_INDEX_PATH=/abs/path/parsed_output/viewer/object_index.json \
VIEWER_FILES_DIR=/abs/path/parsed_output/viewer \
FRONTEND_DIR=/Users/zijian/Desktop/IFCGraphViewer/frontend \
VIEWER_MODEL_URL=/viewer-files/model.glb \
uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8000
```

## 5. Run in Neo4j Mode

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
uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8000
```

## 6. Quick API Checks

```bash
curl http://127.0.0.1:8000/api/health
curl http://127.0.0.1:8000/api/graph/overview
curl "http://127.0.0.1:8000/api/graph/full?limit=1000"
curl "http://127.0.0.1:8000/api/graph/neighborhood?globalId=<GlobalId>&hops=1&limit=500"
curl "http://127.0.0.1:8000/api/object/<GlobalId>"
curl "http://127.0.0.1:8000/api/geometry/<definition_id>"
curl http://127.0.0.1:8000/api/viewer/index
```

## 7. Acceptance

Baseline:

```bash
python scripts/acceptance_check.py \
  --output-dir /abs/path/parsed_output \
  --report-path docs/acceptance_report.json
```

Strict viewer-graph overlap:

```bash
python scripts/acceptance_check.py \
  --output-dir /abs/path/parsed_output \
  --viewer-index-path /abs/path/parsed_output/viewer/object_index.json \
  --viewer-files-dir /abs/path/parsed_output/viewer \
  --frontend-dir /Users/zijian/Desktop/IFCGraphViewer/frontend \
  --report-path docs/acceptance_strict_report.json \
  --require-viewer-index \
  --min-viewer-overlap 100
```

## 8. Troubleshooting

1. `Graph service is not initialized`: ensure app lifespan starts correctly and env vars are complete.
2. `Viewer: mapped 0 objects`: index/model mismatch or wrong `VIEWER_INDEX_PATH`.
3. UI too dense: use filters and neighborhood mode before big picture.
4. Openings look wrong: rebuild assets (V1 excludes `IfcOpeningElement`).
