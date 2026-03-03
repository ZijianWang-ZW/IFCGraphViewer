# Acceptance

## Scope

This check validates dataset loading, API endpoints, and optional viewer-index overlap.

## Command

```bash
python scripts/acceptance_check.py \
  --output-dir /abs/path/parsed_output \
  --report-path docs/acceptance_report.json
```

## Strict Mode (recommended for release)

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

## Pass Conditions

1. Graph dataset has non-zero objects and relations
2. API endpoints return 200 (`/api/health`, `/api/graph/*`, `/api/object/*`, `/api/geometry/*`)
3. Root UI route returns 200
4. Dry graph import check passes (unless explicitly skipped)
5. In strict mode:
   - viewer index is non-empty
   - viewer/object overlap meets threshold

## Output

The script writes JSON report to `--report-path` with:

1. dataset counts and drop stats
2. API status summary
3. pass condition vector
4. final boolean `summary.pass`
